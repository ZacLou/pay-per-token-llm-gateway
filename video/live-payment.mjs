/**
 * Real on-chain payment against the running gateway (video evidence).
 *
 * Performs the full client-side journey on Stellar **testnet** against the
 * gateway on :3100 and records the gateway's actual HTTP responses:
 *
 *   fund → trustline → mint → 402 quote → on-chain USDC payment
 *        → paid retry → replay of the same hash (single-use enforcement)
 *
 * The point of running this (rather than reusing the earlier journey run) is
 * that the demo provider's receiving wallet changed, so the replay guard is
 * exercised fresh — the "already used" rejection below is produced by this
 * run's own payment.
 *
 * Usage:
 *   node video/live-payment.mjs
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { Keypair, Asset, Horizon, TransactionBuilder, Operation, Memo, Networks } = require(
  path.join(ROOT, 'packages', 'wallet', 'node_modules', '@stellar', 'stellar-sdk'),
);

const GATEWAY = process.env.GATEWAY_URL || 'http://127.0.0.1:3100';
const HORIZON = 'https://horizon-testnet.stellar.org';
const FRIENDBOT = 'https://friendbot.stellar.org';
const MODEL = 'gpt-4-journey';
const OUT = path.join(ROOT, 'video', 'assets', 'live');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (msg) => console.log(`  ${msg}`);

async function loadEnvFile(file) {
  try {
    return Object.fromEntries(
      (await readFile(file, 'utf8'))
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
  } catch {
    return {};
  }
}

const server = new Horizon.Server(HORIZON);

/** Submit a signed transaction, polling until Horizon reports it. */
/**
 * Submit a signed envelope straight to Horizon's REST API. Going through the
 * SDK's `submitTransaction` is avoided on purpose: 12.x runs an eager
 * memo-required check that fails on hand-built transactions.
 */
async function submit(tx) {
  const res = await fetch(`${HORIZON}/transactions`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ tx: tx.toXDR() }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const codes = data?.extras?.result_codes;
    throw new Error(`submit failed: ${JSON.stringify(codes || data)}`);
  }
  return { hash: data.hash, ledger: data.ledger };
}

async function waitForAccount(publicKey, attempts = 30) {
  for (let i = 0; i < attempts; i++) {
    try {
      await server.loadAccount(publicKey);
      return;
    } catch {
      await sleep(2000);
    }
  }
  throw new Error(`account ${publicKey} never appeared on Horizon`);
}

async function post(body, headers = {}) {
  const res = await fetch(`${GATEWAY}/api/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  // Capture the on-success receipt header too — the video shows the real
  // receipt, not a reconstruction.
  const receiptHeader = res.headers.get('x-payment-receipt');
  let receipt = null;
  if (receiptHeader) {
    try {
      receipt = JSON.parse(receiptHeader);
    } catch {
      receipt = null;
    }
  }
  return { status: res.status, body: await res.json().catch(() => null), receipt };
}

async function main() {
  await mkdir(OUT, { recursive: true });

  const journey = await loadEnvFile(path.join(ROOT, '.testnet-journey', 'issuer.env'));
  if (!journey.ISSUER_SECRET) throw new Error('missing .testnet-journey/issuer.env');
  const issuer = Keypair.fromSecret(journey.ISSUER_SECRET);
  const usdc = new Asset('USDC', issuer.publicKey());
  log(`issuer ${issuer.publicKey().slice(0, 8)}…`);

  // ── 0. The provider's receiving wallet must exist on-chain and trust the
  //       asset before it can be paid. Idempotent across re-runs.
  const demo = await loadEnvFile(path.join(ROOT, '.testnet-journey', 'demo-wallet.env'));
  if (!demo.DEMO_WALLET_SECRET) throw new Error('missing .testnet-journey/demo-wallet.env');
  const provider = Keypair.fromSecret(demo.DEMO_WALLET_SECRET);

  let providerAccount = await server.loadAccount(provider.publicKey()).catch(() => null);
  if (!providerAccount) {
    log(`provider ${provider.publicKey().slice(0, 8)}… not on-chain — funding via friendbot`);
    await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(provider.publicKey())}`);
    await waitForAccount(provider.publicKey());
    providerAccount = await server.loadAccount(provider.publicKey());
  }

  const providerTrusts = providerAccount.balances.some(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer.publicKey(),
  );
  if (!providerTrusts) {
    const trustTx = new TransactionBuilder(providerAccount, {
      fee: '100000',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.changeTrust({ asset: usdc }))
      .setTimeout(60)
      .build();
    trustTx.sign(provider);
    const r = await submit(trustTx);
    log(`provider trustline ${r.hash.slice(0, 16)}…`);
  }

  // ── 1. Fresh funded payer ────────────────────────────────────────────
  const payer = Keypair.random();
  log(`payer  ${payer.publicKey().slice(0, 8)}… (funding via friendbot)`);
  await fetch(`${FRIENDBOT}?addr=${encodeURIComponent(payer.publicKey())}`);
  await waitForAccount(payer.publicKey());

  const payerAccount = await server.loadAccount(payer.publicKey());

  // ── 2. Trustline + mint ──────────────────────────────────────────────
  // NOTE: Transaction.sign() returns void in stellar-sdk 12.x, so sign the
  // built transaction in place rather than chaining off it.
  const trustlineTx = new TransactionBuilder(payerAccount, {
    fee: '100000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.changeTrust({ asset: usdc }))
    .setTimeout(60)
    .build();
  trustlineTx.sign(payer);
  const trustline = await submit(trustlineTx);
  log(`trustline ${trustline.hash.slice(0, 16)}…`);

  const mintTx = new TransactionBuilder(await server.loadAccount(issuer.publicKey()), {
    fee: '100000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(Operation.payment({ destination: payer.publicKey(), asset: usdc, amount: '100' }))
    .setTimeout(60)
    .build();
  mintTx.sign(issuer);
  const issued = await submit(mintTx);
  log(`mint      ${issued.hash.slice(0, 16)}…`);

  const minted = await server
    .accounts()
    .accountId(payer.publicKey())
    .call()
    .then((a) =>
      a.balances.find((b) => b.asset_code === 'USDC' && b.asset_issuer === issuer.publicKey()),
    );

  // ── 3. Unpaid request → HTTP 402 + quote ─────────────────────────────
  const unpaid = await post({
    model: MODEL,
    messages: [{ role: 'user', content: 'Explain x402 in one sentence.' }],
  });
  if (unpaid.status !== 402) throw new Error(`expected 402, got ${unpaid.status}`);
  const quote = unpaid.body?.quote;
  if (!quote) {
    throw new Error(`402 without a quote: ${JSON.stringify(unpaid.body).slice(0, 300)}`);
  }
  log(`402 quote  ${quote.id} — ${quote.amount} stroops to ${quote.paymentAddress.slice(0, 8)}…`);

  // ── 4. Pay the quote on-chain ────────────────────────────────────────
  await sleep(1000);
  const paymentTx = new TransactionBuilder(await server.loadAccount(payer.publicKey()), {
    fee: '100000',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: quote.paymentAddress,
        asset: usdc,
        amount: (Number(quote.amount) / 1e7).toString(),
      }),
    )
    .addMemo(Memo.text(quote.memo))
    .setTimeout(60)
    .build();
  paymentTx.sign(payer);
  const payment = await submit(paymentTx);
  log(`paid      ${payment.hash} (ledger ${payment.ledger})`);

  const retryBody = {
    model: MODEL,
    messages: [{ role: 'user', content: 'Explain x402 in one sentence.' }],
  };

  // ── 5. Retry with the hash, then replay it ───────────────────────────
  await sleep(2500);
  const first = await post(retryBody, { 'X-Payment-Hash': payment.hash });
  log(`retry     → HTTP ${first.status}`);

  await sleep(1000);
  const replay = await post(retryBody, { 'X-Payment-Hash': payment.hash });
  log(`replay    → HTTP ${replay.status}`);

  const finalBalances = await server.accounts().accountId(payer.publicKey()).call();
  const receiver = await server.loadAccount(quote.paymentAddress).catch(() => null);
  const receiverUsdc = receiver?.balances?.find(
    (b) => b.asset_code === 'USDC' && b.asset_issuer === issuer.publicKey(),
  );

  const evidence = {
    runAt: new Date().toISOString(),
    network: 'testnet',
    gateway: GATEWAY,
    issuer: issuer.publicKey(),
    payer: payer.publicKey(),
    providerWallet: quote.paymentAddress,
    steps: {
      trustline: trustline.hash,
      mint: issued.hash,
      quote: {
        id: quote.id,
        amount: quote.amount,
        asset: quote.asset,
        memo: quote.memo,
        issuedAt: quote.issuedAt,
        expiresAt: quote.expiresAt,
      },
      payment: {
        txHash: payment.hash,
        ledger: payment.ledger,
        amount: '0.1 USDC',
        to: quote.paymentAddress,
        horizon: `${HORIZON}/transactions/${payment.hash}`,
        explorer: `https://stellar.expert/explorer/testnet/tx/${payment.hash}`,
      },
      paidRetry: first,
      replay,
      balances: {
        payerUsdc: minted?.balance,
        providerUsdc: receiverUsdc?.balance ?? '0',
      },
    },
  };

  await writeFile(path.join(OUT, 'live-payment.json'), JSON.stringify(evidence, null, 2));
  log(`evidence written to video/assets/live/live-payment.json`);
}

main().catch((err) => {
  console.error(`\n  ERROR: ${err.message}\n`);
  process.exit(1);
});
