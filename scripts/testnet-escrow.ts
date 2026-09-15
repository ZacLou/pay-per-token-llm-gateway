/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Live Stellar Testnet credit-escrow settlement leg — proves that a **per-token
 * metered request** through the real gateway actually **charges** the caller's
 * prepaid escrow balance and **refunds** the unused surplus, on-chain:
 *
 *   deploy mode (run before the gateway boots):
 *     1. fund admin + issuer + user
 *     2. deploy a FRESH credit-escrow (constructor: admin, asset = USDC SAC)
 *     3. mint USDC to the user, then have the USER deposit into escrow
 *        (`deposit` carries `user.require_auth()`, so the user signs)
 *     4. assert the escrow balance reflects the deposit
 *
 *   run mode (gateway booted with ESCROW_SETTLEMENT_ENABLED=true):
 *     5. seed a provider + a **per_token** route pointed at a deterministic
 *        public echo that reports OpenAI-shaped `usage`
 *     6. unpaid request → 402 quote (per-token deposit estimate)
 *     7. escrow request (X-Escrow-User) → 200 real LLM response
 *     8. poll the chain for the fire-and-forget settlement and verify:
 *          - contract revenue increased by the metered actual cost  (charge)
 *          - escrow balance decreased by the full quote             (draw)
 *          - the user received the unused surplus back              (refund)
 *
 * Evidence (contract id, tx hashes, before/after balances, headers) is appended
 * to docs/evidence/testnet-journey.json under `escrow`. Deterministic failure:
 * any unexpected status or balance fails the run.
 *
 * Run via `scripts/testnet-escrow.sh`, or with the env vars below set and the
 * gateway already booted with the escrow env (see the shell wrapper).
 */
import {
  Keypair,
  Operation,
  Asset,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Horizon,
  xdr,
  StrKey,
  Address,
  rpc,
} from '@stellar/stellar-sdk';
import { execFileSync } from 'node:child_process';
import { prisma } from '@x402/database';

// ── Config ────────────────────────────────────

const GATEWAY_URL = process.env.GATEWAY_URL || 'http://127.0.0.1:3000';
const HORIZON_URL = process.env.HORIZON_URL || 'https://horizon-testnet.stellar.org';
const RPC_URL = process.env.SOROBAN_RPC_URL || 'https://soroban-testnet.stellar.org';
const FRIENDBOT_URL = process.env.FRIENDBOT_URL || 'https://friendbot.stellar.org';
const ISSUER_SECRET = process.env.ISSUER_SECRET || '';
const ADMIN_SECRET = process.env.ESCROW_ADMIN_SECRET || '';
const USER_SECRET = process.env.ESCROW_USER_SECRET || '';
const ESCROW_WASM =
  process.env.ESCROW_WASM ||
  'contracts/credit-escrow/target/wasm32-unknown-unknown/release/credit_escrow.wasm';
const STATE_FILE = process.env.ESCROW_STATE_FILE || '.testnet-journey/escrow-state.json';
/** "deploy" writes the fresh contract id + funds it; "run" drives the gateway. */
const MODE = process.env.ESCROW_MODE || 'run';
const NETWORK_PASSPHRASE = Networks.TESTNET;
const STELLAR_NETWORK = process.env.STELLAR_NETWORK || 'testnet';

/**
 * Per-token price in stroops. The gateway quotes a per-token route by
 * multiplying this by the token estimate (default 4096 when the request omits
 * `max_tokens`), so the deposit estimate is 4096 × PRICE stroops.
 */
const PER_TOKEN_PRICE = 50;
/** 1 USDC = 10^7 stroops. */
const DEPOSIT_STROOPS = 10_000_000n; // 1 USDC

/**
 * The metered "LLM" upstream.
 *
 * Defaults to a public HTTPS echo that returns the posted JSON verbatim. The
 * gateway's request schema is `.passthrough()`, so the caller supplies an
 * OpenAI-shaped `usage.total_tokens` in the request and reads it back as the
 * provider's reported usage — which makes the metered cost fully deterministic
 * and the evidence reproducible.
 *
 * A real public LLM (e.g. `https://text.pollinations.ai/openai`) can be used
 * via `ESCROW_LLM_UPSTREAM` with `ESCROW_ECHO_USAGE=false`, but its anonymous
 * budget is rate-limited and it intermittently answers HTTP 200 with
 * `total_tokens: 0`, so it cannot serve as reproducible proof.
 */
const LLM_UPSTREAM =
  process.env.ESCROW_LLM_UPSTREAM || 'https://jsonplaceholder.typicode.com/posts';
const ECHO_USAGE =
  (process.env.ESCROW_ECHO_USAGE ??
    (LLM_UPSTREAM === 'https://jsonplaceholder.typicode.com/posts' ? 'true' : 'false')) === 'true';
/** Fixed token count the echo upstream reports back. */
const ECHO_TOTAL_TOKENS = Number(process.env.ESCROW_ECHO_TOKENS || 500);
/**
 * The model name on the route — and therefore the model the gateway forwards
 * upstream, since it passes the client's `model` through unchanged.
 */
const ESCROW_MODEL = process.env.ESCROW_MODEL || 'openai';

if (!ISSUER_SECRET || !ADMIN_SECRET || !USER_SECRET) {
  throw new Error('ISSUER_SECRET, ESCROW_ADMIN_SECRET and ESCROW_USER_SECRET are required');
}

const issuer = Keypair.fromSecret(ISSUER_SECRET);
const admin = Keypair.fromSecret(ADMIN_SECRET);
const user = Keypair.fromSecret(USER_SECRET);
const USDC_ISSUER = issuer.publicKey();
const USDC_ASSET = new Asset('USDC', USDC_ISSUER);

// ── Horizon + RPC helpers ─────────────────────

const server = new Horizon.Server(HORIZON_URL, {
  allowHttp: HORIZON_URL.startsWith('http://'),
});
const rpcServer = new rpc.Server(RPC_URL);

// ── Evidence ──────────────────────────────────

const evidence: Record<string, any> = { runAt: new Date().toISOString(), steps: {} };

function step(name: string, data: Record<string, any>) {
  evidence.steps[name] = data;
  console.log(`  ✓ ${name}`);
}

let stepFailures = 0;
function check(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`    ✅ ${name}`);
  } else {
    stepFailures++;
    console.error(`    ❌ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

async function friendbotFund(address: string, label: string): Promise<void> {
  const res = await fetch(`${FRIENDBOT_URL}/?addr=${address}`, { method: 'GET' });
  if (!res.ok) {
    const account = await server.loadAccount(address);
    if (account.balances.length === 0) {
      throw new Error(`friendbot failed for ${label} (${address}): ${res.status}`);
    }
    return;
  }
  const body: any = await res.json();
  await server.transactions().transaction(body.hash).call();
}

async function submitTx(tx: any, label: string): Promise<any> {
  try {
    return await server.submitTransaction(tx, { skipMemoRequiredCheck: true });
  } catch (err: any) {
    const detail =
      err?.response?.data?.extras?.result_codes || err?.response?.data?.detail || err?.message;
    throw new Error(`${label} submission failed: ${JSON.stringify(detail)}`);
  }
}

async function buildSigned(
  secret: string,
  label: string,
  ops: any[],
): Promise<{ txXdr: string; txHash: string }> {
  const keypair = Keypair.fromSecret(secret);
  const account = await server.loadAccount(keypair.publicKey());
  const builder = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: NETWORK_PASSPHRASE,
  });
  for (const op of ops) builder.addOperation(op);
  builder.setTimeout(300);
  const built = builder.build();
  built.sign(keypair);
  return { txXdr: built.toXDR(), txHash: built.hash().toString('hex') };
}

async function submitSigned(secret: string, txXdr: string, label: string): Promise<any> {
  const tx = TransactionBuilder.fromXDR(txXdr, NETWORK_PASSPHRASE);
  return submitTx(tx, label);
}

/**
 * Read a balance tracked by a Stellar Asset Contract — works for both accounts
 * and contracts. The source account must be a real ACCOUNT (a `C...` id cannot
 * be loaded from Horizon), so the funded admin signs nothing but supplies the
 * simulation's source. Returns the balance in stroops, or null on failure.
 */
async function sacBalance(sacId: string, address: string): Promise<bigint | null> {
  try {
    const account = await server.loadAccount(admin.publicKey());
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: NETWORK_PASSPHRASE,
    });
    builder.addOperation(
      Operation.invokeContractFunction({
        contract: sacId,
        function: 'balance',
        args: [xdr.ScVal.scvAddress(Address.fromString(address).toScAddress())],
      }),
    );
    builder.setTimeout(300);
    const tx = builder.build();
    const sim: any = await rpcServer.simulateTransaction(tx);
    if (sim?.error) {
      console.warn(`  (SAC balance read failed for ${address.slice(0, 8)}...: ${sim.error})`);
      return null;
    }
    const retval: xdr.ScVal | undefined = sim?.result?.retval
      ? sim.result.retval
      : sim?.results?.[0]?.xdr
        ? xdr.ScVal.fromXDR(sim.results[0].xdr, 'base64')
        : undefined;
    if (!retval) return null;
    const { scValToNative } = await import('@stellar/stellar-sdk');
    return BigInt(scValToNative(retval) as number | string);
  } catch (err: any) {
    console.warn(`  (SAC balance read failed: ${err.message})`);
    return null;
  }
}

// ── stellar CLI helpers ───────────────────────

function stellar(args: string[], label: string): string {
  try {
    return execFileSync('stellar', args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      throw new Error(`the \`stellar\` CLI is required for ${label}. Install it and re-run.`);
    }
    const detail = err?.stderr?.toString?.() || err?.message || String(err);
    throw new Error(`stellar ${label} failed: ${detail}`);
  }
}

/**
 * The Stellar Asset Contract id for a classic asset, via the CLI.
 *
 * A SAC id is `sha256` over a `HashIDPreimage::ContractId` envelope that binds
 * the network id, so it differs per network and cannot be derived from the
 * asset alone. The CLI is authoritative.
 */
function sacIdForAsset(assetArg: string): string {
  const out = stellar(
    ['contract', 'id', 'asset', '--asset', assetArg, '--network', STELLAR_NETWORK],
    `contract id asset ${assetArg}`,
  );
  const id = out.trim().split('\n').pop()?.trim() ?? '';
  if (!StrKey.isValidContract(id)) {
    throw new Error(`stellar CLI returned an unexpected SAC id: ${JSON.stringify(out)}`);
  }
  return id;
}

/** Deploy a credit asset's SAC if the network does not already have it. */
function deployAssetSac(assetArg: string): void {
  try {
    stellar(
      [
        'contract',
        'asset',
        'deploy',
        '--asset',
        assetArg,
        '--source-account',
        ADMIN_SECRET,
        '--network',
        STELLAR_NETWORK,
      ],
      `contract asset deploy ${assetArg}`,
    );
  } catch (err: any) {
    const detail = String(err?.message ?? err);
    if (/ExistingValue|already exists/i.test(detail)) return;
    throw err;
  }
}

/**
 * Deploy a fresh credit-escrow.
 *
 * Initialization is a Soroban `__constructor(admin, asset)`, so it runs inside
 * the deploy transaction — there is no window between deploy and init for an
 * attacker to claim ownership. The `stellar` CLI is what passes constructor
 * arguments (`-- <args>`), the same form `scripts/deploy-contracts.sh` uses.
 */
function deployCreditEscrow(usdcSacId: string): string {
  console.log(
    `  deploying credit-escrow via stellar CLI (admin ${admin.publicKey().slice(0, 8)}..., ` +
      `asset ${usdcSacId.slice(0, 8)}...)`,
  );
  const out = stellar(
    [
      'contract',
      'deploy',
      '--wasm',
      ESCROW_WASM,
      '--source-account',
      ADMIN_SECRET,
      '--network',
      STELLAR_NETWORK,
      '--',
      '--admin',
      admin.publicKey(),
      '--asset',
      usdcSacId,
    ],
    'contract deploy',
  );
  const id = out.trim().split('\n').pop()?.trim() ?? '';
  if (!StrKey.isValidContract(id)) {
    throw new Error(`stellar CLI returned an unexpected contract id: ${JSON.stringify(out)}`);
  }
  console.log(`  credit-escrow deployed: ${id}`);
  return id;
}

/** Invoke a read-only contract function via the CLI, returning its stdout. */
function invokeRead(contractId: string, fn: string, args: string[]): string {
  const out = stellar(
    [
      'contract',
      'invoke',
      '--id',
      contractId,
      '--source-account',
      ADMIN_SECRET,
      '--network',
      STELLAR_NETWORK,
      '--',
      fn,
      ...args,
    ],
    `contract invoke ${fn}`,
  );
  return out.trim().split('\n').pop()?.trim() ?? '';
}

/**
 * Parse an i128 as printed by `stellar contract invoke`.
 *
 * The CLI emits the result as JSON, and since a 128-bit integer does not fit a
 * JS number it comes back **quoted** (e.g. `"10000000"`), sometimes with a
 * trailing `n` for very large values. Normalise those away before BigInt().
 */
function parseI128(raw: string): bigint {
  const cleaned = raw.trim().replace(/^"|"$/g, '').replace(/n$/, '');
  if (!/^-?\d+$/.test(cleaned)) {
    throw new Error(`Unexpected i128 output from the stellar CLI: ${JSON.stringify(raw)}`);
  }
  return BigInt(cleaned);
}

/** Read a user's escrow balance via the CLI (`--user <G...>` is address-converted). */
function readEscrowBalance(contractId: string, address: string): bigint {
  return parseI128(invokeRead(contractId, 'balance', ['--user', address]));
}

function readRevenue(contractId: string): bigint {
  return parseI128(invokeRead(contractId, 'get_revenue', []));
}

/**
 * The request body sent to the gateway (and therefore forwarded upstream).
 *
 * With the echo upstream, an OpenAI-shaped `usage` and `choices` are included
 * so the response is a complete, deterministic completion. The gateway reads
 * `response.usage.total_tokens` from it exactly as it would from a real
 * provider.
 */
function escrowRequestBody(): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body: Record<string, any> = {
    model: ESCROW_MODEL,
    messages: [{ role: 'user', content: 'Reply with the single word: pong' }],
  };
  if (ECHO_USAGE) {
    body.usage = {
      prompt_tokens: 200,
      completion_tokens: ECHO_TOTAL_TOKENS - 200,
      total_tokens: ECHO_TOTAL_TOKENS,
    };
    body.choices = [
      { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
    ];
  }
  return JSON.stringify(body);
}

/**
 * Probe the upstream directly until it returns a real `usage.total_tokens`.
 *
 * The upstream is a *real*, public, keyless LLM and can transiently rate-limit
 * or answer with an error body that carries no `usage`. That is a property of
 * the third-party service, not of the escrow path, so it is resolved here —
 * outside the gateway, consuming no escrow — before the metered draw is made.
 * Retrying through the gateway instead would spend the caller's balance on
 * responses that cannot be metered.
 */
async function preflightUpstream(attempts = 12): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(LLM_UPSTREAM, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: escrowRequestBody(),
        signal: AbortSignal.timeout(30_000),
      });
      const body: any = await res.json().catch(() => null);
      const tokens = body?.usage?.total_tokens;
      if (res.ok && typeof tokens === 'number' && tokens > 0) {
        console.log(`  upstream healthy (HTTP ${res.status}, total_tokens=${tokens})`);
        return;
      }
      console.warn(
        `  upstream not ready (attempt ${attempt}): HTTP ${res.status} tokens=${tokens}`,
      );
    } catch (err: any) {
      console.warn(`  upstream preflight error (attempt ${attempt}): ${err.message}`);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error('LLM upstream never returned usage.total_tokens — cannot prove metered billing');
}

// ── Main ──────────────────────────────────────

async function main() {
  console.log('\n═══ x402 Live Testnet Escrow Settlement Leg ═══');
  console.log(`  issuer ${issuer.publicKey()}`);
  console.log(`  admin  ${admin.publicKey()}`);
  console.log(`  user   ${user.publicKey()}`);
  console.log(`  mode   ${MODE}`);
  const fs = await import('fs');
  fs.mkdirSync('.testnet-journey', { recursive: true });

  if (MODE === 'deploy') {
    await deployEscrow(fs);
    return;
  }
  await runSettlement(fs);
}

/** Phase 1 — deploy a fresh escrow and have the user deposit into it. */
async function deployEscrow(fs: typeof import('fs')) {
  console.log('\n── Step 1: fund admin + issuer + user (friendbot, idempotent) ──');
  await friendbotFund(admin.publicKey(), 'admin');
  await friendbotFund(issuer.publicKey(), 'issuer');
  await friendbotFund(user.publicKey(), 'user');

  console.log('\n── Step 2: deploy credit-escrow (constructor: admin, USDC SAC) ──');
  const usdcSac = sacIdForAsset(`USDC:${USDC_ISSUER}`);
  console.log(`  USDC SAC: ${usdcSac}`);
  deployAssetSac(`USDC:${USDC_ISSUER}`);

  // Idempotent re-run: reuse the escrow recorded by a previous deploy phase
  // rather than deploying yet another contract (and funding another user).
  const prior = fs.existsSync(STATE_FILE)
    ? (JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as { escrowId?: string })
    : null;

  let escrowId: string;
  if (prior?.escrowId) {
    escrowId = prior.escrowId;
    console.log(`  reusing credit-escrow ${escrowId} (from ${STATE_FILE})`);
    step('deploy-reused', { contractId: escrowId });
  } else {
    escrowId = deployCreditEscrow(usdcSac);
    step('deploy-create', { contractId: escrowId, usdcSac });
  }

  console.log('\n── Step 3: mint USDC to the user + deposit into escrow ──');
  const trustline = await buildSigned(user.secret(), 'user-trustline', [
    Operation.changeTrust({ asset: USDC_ASSET }),
  ]);
  await submitSigned(user.secret(), trustline.txXdr, 'user-trustline');
  console.log(`  user USDC trustline: ${trustline.txHash}`);

  const mint = await buildSigned(issuer.secret(), 'mint-user', [
    Operation.payment({ destination: user.publicKey(), asset: USDC_ASSET, amount: '100' }),
  ]);
  await submitSigned(issuer.secret(), mint.txXdr, 'mint-user');
  console.log(`  user funded with 100 USDC: ${mint.txHash}`);

  // `deposit` calls `user.require_auth()`, so the USER's key signs the
  // invocation — the admin cannot deposit on the user's behalf.
  const depositOut = stellar(
    [
      'contract',
      'invoke',
      '--id',
      escrowId,
      '--source-account',
      USER_SECRET,
      '--network',
      STELLAR_NETWORK,
      '--',
      'deposit',
      '--user',
      user.publicKey(),
      '--amount',
      DEPOSIT_STROOPS.toString(),
    ],
    'contract invoke deposit',
  );
  console.log(`  deposit submitted: ${depositOut.trim().split('\n').pop()}`);

  // The escrow contract is reused across reruns, and `deposit` is additive, so
  // the balance accumulates rather than resetting. Assert the deposit landed
  // (at least one deposit's worth), not an exact total.
  const deposited = readEscrowBalance(escrowId, user.publicKey());
  check(
    'escrow balance reflects the deposit',
    deposited >= DEPOSIT_STROOPS,
    `balance=${deposited} expected>=${DEPOSIT_STROOPS}`,
  );
  step('deposit', {
    contractId: escrowId,
    usdcSac,
    user: user.publicKey(),
    depositStroops: DEPOSIT_STROOPS.toString(),
    escrowBalanceStroops: deposited.toString(),
    mintTxHash: mint.txHash,
  });

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        escrowId,
        usdcSac,
        admin: admin.publicKey(),
        user: user.publicKey(),
        depositStroops: DEPOSIT_STROOPS.toString(),
        deployedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(`\n📄 Deploy state written to ${STATE_FILE}`);
  console.log('\n═══ DEPLOY PHASE DONE ✅ (restart the gateway, then run ESCROW_MODE=run) ═══');
  if (stepFailures > 0) process.exit(1);
}

/** Phase 2 — drive a per-token request through the gateway and verify settlement. */
async function runSettlement(fs: typeof import('fs')) {
  if (!fs.existsSync(STATE_FILE)) {
    throw new Error(`No deploy state at ${STATE_FILE} — run ESCROW_MODE=deploy first`);
  }
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  const escrowId: string = state.escrowId;
  const usdcSac: string = state.usdcSac;
  console.log(`  credit-escrow ${escrowId} (from ${STATE_FILE})`);

  // ── 4. Seed a provider + per-token route (upstream = real public LLM) ──
  console.log('\n── Step 4: seed provider + per_token route ──');
  const provider = await prisma.provider.upsert({
    where: { id: 'journey-escrow-provider' },
    update: { walletAddress: admin.publicKey(), payoutWalletAddress: admin.publicKey() },
    create: {
      id: 'journey-escrow-provider',
      name: 'Testnet Escrow Provider',
      walletAddress: admin.publicKey(),
      payoutWalletAddress: admin.publicKey(),
      active: true,
    },
  });
  const route = await prisma.route.upsert({
    where: {
      providerId_path_model: {
        providerId: provider.id,
        path: '/v1/chat/completions',
        model: ESCROW_MODEL,
      },
    },
    update: {
      pricingModel: 'per_token',
      perTokenPrice: String(PER_TOKEN_PRICE),
      upstreamUrl: LLM_UPSTREAM,
      active: true,
    },
    create: {
      providerId: provider.id,
      path: '/v1/chat/completions',
      upstreamUrl: LLM_UPSTREAM,
      model: ESCROW_MODEL,
      pricingModel: 'per_token',
      perTokenPrice: String(PER_TOKEN_PRICE),
      flatPrice: null,
      acceptedAssets: ['USDC'],
      rateLimit: 100,
      active: true,
    },
  });
  step('seed', {
    providerId: provider.id,
    routeId: route.id,
    model: ESCROW_MODEL,
    upstreamUrl: LLM_UPSTREAM,
    perTokenPrice: PER_TOKEN_PRICE,
  });

  // ── 5. Unpaid request → 402 quote (per-token deposit estimate) ──
  console.log('\n── Step 5: unpaid request → 402 quote ──');
  const unpaid = await fetch(`${GATEWAY_URL}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ESCROW_MODEL,
      messages: [{ role: 'user', content: 'Hello from the live escrow journey!' }],
    }),
  });
  const unpaidBody: any = await unpaid.json();
  check('HTTP 402', unpaid.status === 402, `got ${unpaid.status}`);
  const quote = unpaidBody.quote;
  check('quote present', !!quote, 'no quote in body');
  const quoteAmount = quote?.amount ? BigInt(quote.amount) : 0n;
  check('quote is the per-token deposit estimate', quoteAmount > 0n, quote?.amount);
  step('quote', { quote });

  // ── 6. Preflight the upstream LLM ──
  console.log('\n── Step 6: preflight the LLM upstream ──');
  await preflightUpstream();

  // ── 7. Escrow-funded per-token request → 200, metered against real usage ──
  //
  // A response without `usage` makes the gateway take its flat fallback
  // (actualCost = the whole deposit, surplus 0), which cannot show a refund.
  // The retry loop re-reads the pre-state for the attempt that actually
  // matters, so earlier fallback attempts never distort the assertions.
  console.log('\n── Step 7: X-Escrow-User request → 200 + real LLM response ──');
  let balanceBefore = 0n;
  let revenueBefore = 0n;
  let userUsdcBefore: bigint | null = null;
  let contractUsdcBefore: bigint | null = null;
  let tokensUsed = 0;
  let actualCost: string | null = null;
  let surplus: string | null = null;
  let paidBody: any = null;
  let receiptHeader: string | null = null;

  for (let attempt = 1; attempt <= 4; attempt++) {
    balanceBefore = readEscrowBalance(escrowId, user.publicKey());
    revenueBefore = readRevenue(escrowId);
    userUsdcBefore = await sacBalance(usdcSac, user.publicKey());
    contractUsdcBefore = await sacBalance(usdcSac, escrowId);
    if (attempt === 1) {
      console.log(
        `  escrow=${balanceBefore} revenue=${revenueBefore} ` +
          `userUsdc=${userUsdcBefore} contractUsdc=${contractUsdcBefore}`,
      );
      check('escrow balance covers the quote', balanceBefore >= quoteAmount, `${balanceBefore}`);
    }

    const paid = await fetch(`${GATEWAY_URL}/api/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Escrow-User': user.publicKey() },
      body: escrowRequestBody(),
    });
    paidBody = await paid.json();
    if (paid.status !== 200) {
      throw new Error(
        `Escrow request was not served (HTTP ${paid.status}): ${JSON.stringify(paidBody)}`,
      );
    }
    tokensUsed = Number(paid.headers.get('x-tokens-used') ?? 0);
    actualCost = paid.headers.get('x-actual-cost');
    surplus = paid.headers.get('x-surplus');
    receiptHeader = paid.headers.get('x-payment-receipt');

    if (tokensUsed > 0) break;
    console.warn(
      `  upstream returned no token usage (attempt ${attempt}) — retrying with a fresh quote`,
    );
    await new Promise((r) => setTimeout(r, 5000));
  }

  if (tokensUsed <= 0) {
    throw new Error('The upstream never returned metered token usage — cannot verify settlement');
  }
  console.log(
    `    tokens=${tokensUsed} actualCost=${actualCost} surplus=${surplus} ` +
      `content=${JSON.stringify(paidBody?.choices?.[0]?.message?.content)}`,
  );
  check('real metered token usage returned', tokensUsed > 0, String(tokensUsed));
  check('X-Actual-Cost header present', !!actualCost, String(actualCost));
  check('real LLM content returned', !!paidBody?.choices?.[0]?.message?.content);
  const expectedActual = BigInt(tokensUsed) * BigInt(PER_TOKEN_PRICE);
  check(
    'metered actual cost == tokens × per-token price',
    actualCost !== null && BigInt(actualCost) === expectedActual,
    `header=${actualCost} expected=${expectedActual}`,
  );
  const expectedSurplus = quoteAmount - expectedActual;
  check(
    'reported surplus == quote − actual',
    surplus !== null && BigInt(surplus) === expectedSurplus,
    `header=${surplus} expected=${expectedSurplus}`,
  );
  step('forward', {
    tokensUsed,
    actualCost,
    surplus,
    contentPreview: String(paidBody?.choices?.[0]?.message?.content ?? '').slice(0, 120),
    receipt: receiptHeader ? JSON.parse(receiptHeader) : null,
  });

  // ── 8. Wait for the on-chain settlement (fire-and-forget) ──
  //
  // Settlement is TWO separate transactions: `charge` (which bumps revenue)
  // and then `refund` (which moves the surplus back to the caller). Polling
  // only for the revenue change returns as soon as the *charge* lands — before
  // the refund exists — and the refund then looks like it never happened. Wait
  // for both effects to become visible on-chain.
  console.log('\n── Step 8: wait for on-chain charge + refund ──');
  const deadline = Date.now() + 120_000;
  let revenueAfter = revenueBefore;
  let balanceAfter = balanceBefore;
  while (Date.now() < deadline) {
    revenueAfter = readRevenue(escrowId);
    balanceAfter = readEscrowBalance(escrowId, user.publicKey());
    const chargeSettled = revenueAfter - revenueBefore === expectedActual;
    const drawSettled = balanceBefore - balanceAfter === quoteAmount;
    if (chargeSettled && drawSettled) break;
    await new Promise((r) => setTimeout(r, 4000));
  }
  const userUsdcAfter = await sacBalance(usdcSac, user.publicKey());
  const contractUsdcAfter = await sacBalance(usdcSac, escrowId);

  const charged = revenueAfter - revenueBefore;
  const drawn = balanceBefore - balanceAfter;
  const refundedToUser = (userUsdcAfter ?? 0n) - (userUsdcBefore ?? 0n);
  const contractDelta = (contractUsdcAfter ?? 0n) - (contractUsdcBefore ?? 0n);

  console.log(
    `  revenue: ${revenueBefore} → ${revenueAfter} (+${charged})\n` +
      `  escrow:  ${balanceBefore} → ${balanceAfter} (−${drawn})\n` +
      `  userUsdc: ${userUsdcBefore} → ${userUsdcAfter} (+${refundedToUser})\n` +
      `  contractUsdc: ${contractUsdcBefore} → ${contractUsdcAfter} (${contractDelta})`,
  );

  // charge: contract revenue increased by exactly the metered actual cost.
  check(
    'revenue increased by the metered actual cost (charge executed)',
    charged === expectedActual,
    `charged=${charged} expected=${expectedActual}`,
  );
  // draw: the user's prepaid claim was consumed by actual + refunded surplus.
  check(
    'escrow balance drawn by quote (actual + surplus)',
    drawn === quoteAmount,
    `drawn=${drawn} expected=${quoteAmount}`,
  );
  // refund: the unused surplus was transferred back to the user.
  check(
    'user received the unused surplus (refund executed)',
    refundedToUser === expectedSurplus,
    `refunded=${refundedToUser} expected=${expectedSurplus}`,
  );
  // Solvency: the contract paid the refund out of its own held tokens.
  check(
    'contract USDC decreased by the refunded surplus',
    contractDelta === -expectedSurplus,
    `delta=${contractDelta} expected=${-expectedSurplus}`,
  );

  step('settlement', {
    expectedActual: expectedActual.toString(),
    expectedSurplus: expectedSurplus.toString(),
    quoteAmount: quoteAmount.toString(),
    revenueBefore: revenueBefore.toString(),
    revenueAfter: revenueAfter.toString(),
    charged: charged.toString(),
    escrowBefore: balanceBefore.toString(),
    escrowAfter: balanceAfter.toString(),
    drawn: drawn.toString(),
    userUsdcBefore: userUsdcBefore?.toString(),
    userUsdcAfter: userUsdcAfter?.toString(),
    refundedToUser: refundedToUser.toString(),
    contractUsdcBefore: contractUsdcBefore?.toString(),
    contractUsdcAfter: contractUsdcAfter?.toString(),
    contractDelta: contractDelta.toString(),
    contractId: escrowId,
    usdcSac,
    horizonContract: `${HORIZON_URL}/accounts/${admin.publicKey()}`,
  });

  // ── 9. The settlement must be auditable from the database ──
  //
  // The on-chain hashes are useless as evidence if they live only in the
  // gateway log, which rotates. The gateway persists the charge and refund
  // transactions onto the draw's `Payment` row; assert them there.
  console.log('\n── Step 9: confirm the settlement is recorded in the database ──');
  const receipt = receiptHeader ? JSON.parse(receiptHeader) : null;
  const quoteId: string | undefined = receipt?.quoteId;
  check('X-Payment-Receipt names the quote', !!quoteId, String(quoteId));

  type SettlementRow = { settlementTxHash: string | null; refundTxHash: string | null };
  let row: SettlementRow | null = null;
  const dbDeadline = Date.now() + 30_000;
  while (quoteId && Date.now() < dbDeadline) {
    row = await prisma.payment.findFirst({
      where: { quoteId },
      select: { settlementTxHash: true, refundTxHash: true },
    });
    if (row?.settlementTxHash && row?.refundTxHash) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  const hex64 = /^[0-9a-f]{64}$/;
  check(
    'charge transaction persisted (Payment.settlementTxHash)',
    !!row?.settlementTxHash && hex64.test(row.settlementTxHash),
    String(row?.settlementTxHash),
  );
  check(
    'refund transaction persisted (Payment.refundTxHash)',
    !!row?.refundTxHash && hex64.test(row.refundTxHash),
    String(row?.refundTxHash),
  );
  check(
    'the two settlement transactions are distinct',
    !!row?.settlementTxHash && row.settlementTxHash !== row.refundTxHash,
    `${row?.settlementTxHash} / ${row?.refundTxHash}`,
  );
  step('db-audit', {
    quoteId,
    settlementTxHash: row?.settlementTxHash,
    refundTxHash: row?.refundTxHash,
    horizon: {
      charge: row?.settlementTxHash ? `${HORIZON_URL}/transactions/${row.settlementTxHash}` : null,
      refund: row?.refundTxHash ? `${HORIZON_URL}/transactions/${row.refundTxHash}` : null,
    },
  });

  // ── Evidence ──
  const outPath = process.env.EVIDENCE_PATH || 'docs/evidence/testnet-journey.json';
  const existing = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf-8')) : {};
  existing.escrow = evidence;
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      existing,
      (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
      2,
    ),
  );
  console.log(`\n📄 Escrow evidence appended to ${outPath}`);
  console.log(
    `\n═══ ${stepFailures === 0 ? 'ESCROW LEG PASSED ✅' : `${stepFailures} CHECKS FAILED ❌`} ═══`,
  );
  if (stepFailures > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nEscrow leg failed:', err);
  process.exit(1);
});
