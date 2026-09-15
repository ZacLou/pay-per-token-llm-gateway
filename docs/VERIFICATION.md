# Verification

Reproducible evidence for what this repository actually does. Every claim below
is either backed by a command you can run or a transaction you can look up
yourself. Anything that is **not** verified is listed under
[Not verified](#not-verified) — treat that section as the honest boundary of
this document.

Last verified: **2026-09-15** · Stellar **Testnet** · commit `4db5a2b`

---

## 1. Endpoints

| What               | URL                                                       | State                                            |
| ------------------ | --------------------------------------------------------- | ------------------------------------------------ |
| Dashboard (public) | `https://pay-per-token-llm-gateway-dashboard.vercel.app/` | ⚠️ Reachable, **not functional** — see §7        |
| Gateway API        | —                                                         | ❌ **Not deployed anywhere.** Runs locally only. |
| Stellar network    | `testnet`                                                 | `https://horizon-testnet.stellar.org`            |
| Soroban RPC        | —                                                         | `https://soroban-testnet.stellar.org`            |

There is **no public gateway**, so the deployed dashboard has nothing to call.
Pointing the dashboard at a local gateway does work — that is what §5 verifies.

## 2. Contract addresses (Testnet)

From [`contracts/deployed-addresses.json`](../contracts/deployed-addresses.json):

| Contract          | Address                                                    |
| ----------------- | ---------------------------------------------------------- |
| `paymentVerifier` | `CDHGI3A2BXRC5AQDPWEEXUDQMDXTDZYBCLJZWSE5XZKMVEGJ5LLHA4CZ` |
| `creditEscrow`    | `CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP` |
| `multisig`        | `CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA` |

Native XLM SAC (Testnet, network-constant):
`CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC`

> **Note:** SAC addresses are derived per network. Deriving them without the
> network id produces a valid-looking address where no contract exists — see
> the bug in §8.

## 3. Prerequisites

- Node 24 (see `.nvmrc`), pnpm 11.24 (`corepack prepare pnpm@11.24.0 --activate`)
- Docker (Postgres + Redis for the live runs)
- Rust + `wasm32-unknown-unknown` — for the contracts
- `stellar` CLI — required by the payout leg and for SAC derivation
- Public network access to Stellar Testnet (Horizon, friendbot, Soroban RPC)
- **No funded keypair needed**: every run generates fresh accounts and funds
  them from friendbot.

```bash
rustup toolchain install stable --profile minimal
rustup target add wasm32-unknown-unknown
# stellar CLI: https://github.com/stellar/stellar-cli/releases
```

## 4. Setup and test commands

```bash
# 1. install + baseline
pnpm install --frozen-lockfile
pnpm test          # unit + integration suites, all projects
pnpm lint
pnpm build

# 2. Soroban contracts
for c in payment-verifier credit-escrow multisig; do (cd contracts/$c && cargo test); done
pnpm build:contracts   # wasm + size gate

# 3. live end-to-end (boots Postgres + Redis + gateway, real Testnet payment)
bash scripts/testnet-journey.sh

# 4. dashboard against a live gateway (drives the dashboard's own api.ts)
bash scripts/dashboard-e2e.sh
```

Steps 3 and 4 write machine-readable receipts to
[`docs/evidence/`](./evidence).

## 5. Results

### Unit / integration

| Suite                    | Result                            |
| ------------------------ | --------------------------------- |
| `pnpm test` (8 projects) | **244 gateway tests, 0 failures** |
| `pnpm lint`              | 0 errors (warnings only)          |
| `pnpm build`             | clean                             |

### Soroban contracts

| Contract           | `cargo test`   | WASM  | Size gate (< 64 KiB) |
| ------------------ | -------------- | ----- | -------------------- |
| `payment-verifier` | **29 passed**  | 7 KiB | ✅                   |
| `credit-escrow`    | **46 passed**  | 9 KiB | ✅                   |
| `multisig`         | **36 passed**  | 7 KiB | ✅                   |
| **Total**          | **111 passed** |       |                      |

Suites include the accounting-invariant, replay, authorization, TTL and
gas/storage benchmark tests.

### Dashboard against a live gateway

`scripts/dashboard-e2e.sh` drives `apps/dashboard/src/lib/api.ts` (the real
client, not curl) and asserts every page's data source returns real rows:
providers, routes, analytics summary (numeric, and moving with activity),
payments, audit log, notifications. It also production-builds the dashboard and
asserts `NEXT_PUBLIC_GATEWAY_URL` landed in the **client** bundle.

**Result: all checks passed.** Evidence: [`docs/evidence/dashboard-e2e.json`](./evidence/dashboard-e2e.json).

## 6. Payment flow — real Testnet evidence

Reproduce with `bash scripts/testnet-journey.sh`.

### Happy path

| Step                        | Result                                                                |
| --------------------------- | --------------------------------------------------------------------- |
| Unpaid request              | `402` + quote (amount `1000000` stroops, asset `USDC`, issuer echoed) |
| On-chain payment            | see tx below                                                          |
| Retry with `X-Payment-Hash` | `200` + `X-Payment-Receipt` (`status: confirmed`, `txHash` matches)   |
| Receiver balance            | `0.1 USDC`                                                            |

Payment transaction, independently confirmed on Horizon:

```
hash      0d75bef8e500be0c495e0b5360b108bed959f12f608abfbb3a426b693f814731
successful  true
ledger     4687623
closed      2026-09-15T08:41:42Z
operation  payment  0.1000000 USDC
https://stellar.expert/explorer/testnet/tx/0d75bef8e500be0c495e0b5360b108bed959f12f608abfbb3a426b693f814731
```

### Rejection cases

| Case                                | Response                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Replayed hash (same tx twice)       | `402` — _"This payment has already been used. A new payment is required."_ |
| Forged hash (`f`×64, never existed) | `402` — _"Payment verification failed: Transaction not found on chain"_    |

Payment verification is single-use enforced in Redis **and** on-chain, and
unknown hashes fail closed. An unpaid request never reaches the LLM.

## 7. Dashboard deployment — not functional

The deployed dashboard is a **stale build**: its client bundle still resolves
the gateway URL to `http://localhost:3000`, so every request targets the
visitor's own machine and the page stays on `Connecting…` / `Loading…`. On top
of that, **no gateway is deployed**, so there is nothing to connect to.

The client-side fix is in `main` (`647441e`) but has not been redeployed, and
the Vercel deploy workflow has never actually run — it skipped on a missing
`VERCEL_TOKEN` while reporting success. See `DEPLOYMENT.md` for the required
environment (`NEXT_PUBLIC_GATEWAY_URL` in Vercel, `CORS_ORIGINS` on the
gateway). `NEXT_PUBLIC_*` is inlined at **build** time, so changing it requires
a rebuild.

## 8. Defects found and fixed during verification

These were found by running the system, not by reading it.

| #   | Defect                                                                                                                                                                                                                                                                                                                                                                                                                       | Evidence it was real                                                                                                                                                                                       | Status                                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1   | **Soroban signing used the wrong SDK API at 8 call sites.** `tx.signAuthEntries(keypair)` / `tx.sign(keypair)` pass a `Keypair` where an options object is required, and drop the promise. Result: the SDK read `publicKey` _off_ the Keypair and got the unbound method, so no auth entry matched (`NoSignatureNeeded`); `send()` ran unsigned; and the abandoned promise rejected **unhandled**, killing the Node process. | The gateway **died** on `POST /admin/payouts/propose`. Crash message contained the stringified method: `No auth entries for public key "function publicKey() { … }"`                                       | **Fixed** — now uses the SDK's `basicNodeSigner` and awaits. Gateway returns a clean `503` and stays up. |
| 2   | Contract could not be funded with XLM via a classic `PaymentOp` — a `MuxedAccount` only carries an ed25519 key, so the contract id named a non-existent account                                                                                                                                                                                                                                                              | `tx_failed` / `op_no_destination`; the native-SAC route then succeeded ([`fe7db954…`](https://stellar.expert/explorer/testnet/tx/fe7db95403995d23e69730caab17f82afd34a0f6081af2872acae9552c7becdd))        | Fixed                                                                                                    |
| 3   | **SAC derivation omitted the network id**, so it produced a well-formed address with no contract behind it                                                                                                                                                                                                                                                                                                                   | Reproduced the wrong value exactly (`CDF3YSDV…` vs the real `CDLZFC3S…`); RPC returned `Error(Storage, MissingValue)`. Now asked of the `stellar` CLI, which is authoritative                              | Fixed                                                                                                    |
| 4   | A credit asset's SAC was never deployed, but the journey mints from a fresh issuer each run                                                                                                                                                                                                                                                                                                                                  | `MissingValue` on the USDC transfer; `stellar contract asset deploy` fixed it ([`7135691c…`](https://stellar.expert/explorer/testnet/tx/7135691c20bd02b58056089a85a745b978e181fa8aba22146b4225243f1002cf)) | Fixed                                                                                                    |
| 5   | `Payment.routeId` referenced a route that was never inserted — a real foreign key                                                                                                                                                                                                                                                                                                                                            | Prisma `P2003 Foreign key constraint violated: Payment_routeId_fkey`                                                                                                                                       | Fixed                                                                                                    |
| 6   | **Dashboard image could not be built at all** — production stage copied from `dist/apps/dashboard/.next`, but `@nx/next:build` writes to `apps/dashboard/.next`                                                                                                                                                                                                                                                              | `docker build` → `failed to compute cache key: … not found`                                                                                                                                                | Fixed                                                                                                    |
| 7   | Dashboard container listened on 3000 while compose/probes/Service all advertise 3001                                                                                                                                                                                                                                                                                                                                         | Standalone `server.js` reads `PORT` → 3000; configmap injected `PORT=3000`                                                                                                                                 | Fixed                                                                                                    |
| 8   | Shipped `CORS_ORIGINS` allow-listed a _different, disabled_ Vercel app                                                                                                                                                                                                                                                                                                                                                       | `x402-dashboard.vercel.app` returns `DEPLOYMENT_DISABLED`; the real origin appeared nowhere in the repo                                                                                                    | Fixed                                                                                                    |
| 9   | CI inlining guard built only `--target builder` and asserted a path Nx never produces                                                                                                                                                                                                                                                                                                                                        | Job red for the wrong reason while the real defect sat underneath                                                                                                                                          | Fixed — now builds the full image                                                                        |

### Why the tests missed #1

The specs mocked `signAuthEntries` / `sign` as bare `jest.fn()`s on a fake
keypair, encoding the _wrong_ API contract — so they passed regardless. They now
use a **real `Keypair`** and the real `basicNodeSigner`, so the path is actually
exercised.

## 9. Not verified

Recorded deliberately, so nothing here is mistaken for a working feature.

1. **Provider payout leg does not complete.** It now gets all the way through
   on-chain deployment, XLM and USDC funding, wallet auth and the propose call,
   but the proposal is rejected with **`txBadSeq`** (tx
   `17b4f9700087f2323ab363e60d6aece0652b3f8973e78ef24b7b0ba41f5b6d5f`). The
   contract-side transfer therefore never executes, and no payout has been
   observed completing end-to-end.
2. **Escrow settlement has not moved value on-chain.** The wiring is in
   `settleEscrowDraw` and the client is now correct, but the live journey uses a
   flat-priced route, so escrow is never charged on-chain in the verification
   run. Treat escrow settlement as **implemented, not proven**.
3. **No public deployment.** No gateway is hosted; the dashboard URL is stale.
   Nothing about the deployed system is verified.
4. **Failure-injection cases** (Postgres/Redis/RPC down, LLM provider failure,
   network interruption) are exercised only by unit tests with mocked
   dependencies — not against a live stack.
5. **Webhook and email delivery** are unit-tested, not delivered to a real
   external receiver. SSE receipt streaming is covered by e2e tests, not by a
   browser.
6. **No external security audit.** Contracts are self-tested only.
7. **Python/LangChain SDK** is tested against mocks, not against live Testnet.

## 10. Verifying this document yourself

```bash
git clone https://github.com/mallonepay/pay-per-token-llm-gateway.git
cd pay-per-token-llm-gateway
pnpm install --frozen-lockfile && pnpm test && pnpm lint
for c in payment-verifier credit-escrow multisig; do (cd contracts/$c && cargo test); done
bash scripts/testnet-journey.sh     # main journey green; payout leg fails at txBadSeq
bash scripts/dashboard-e2e.sh       # all checks pass
```

Then look up any hash in §6 or §8 at
`https://stellar.expert/explorer/testnet/tx/<hash>`. Testnet funds have no
value; no mainnet transaction is claimed anywhere in this repository.
