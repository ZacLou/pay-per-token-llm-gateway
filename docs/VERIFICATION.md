# Verification

Reproducible evidence for what this repository actually does. Every claim below
is either backed by a command you can run or a transaction you can look up
yourself. Anything that is **not** verified is listed under
[Not verified](#not-verified) — treat that section as the honest boundary of
this document.

Last verified: **2026-09-15** · Stellar **Testnet** · commit `3572b94` plus the
uncommitted fixes in §8 (`#11`–`#15`)

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
> the bug in §8. The live harness now asks the `stellar` CLI for authoritative
> IDs rather than computing them.
>
> The addresses above are the contracts deployed by the manual deploy script.
> The payout leg deploys its **own** fresh multisig
> (`CBQQSVQA…RMTL`) against the journey's self-issued USDC, so its evidence is
> independent of the table in this section.

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

# 3b. live credit-escrow settlement (per-token route → on-chain charge + refund)
bash scripts/testnet-escrow.sh

# 4. dashboard against a live gateway (drives the dashboard's own api.ts)
bash scripts/dashboard-e2e.sh
```

Steps 3 and 4 write machine-readable receipts to
[`docs/evidence/`](./evidence).

## 5. Results

### Unit / integration

| Suite                    | Result                                     |
| ------------------------ | ------------------------------------------ |
| `pnpm test` (8 projects) | **477 tests, 0 failures** (245 in gateway) |
| `pnpm lint`              | 0 errors (warnings only)                   |
| `pnpm build`             | clean                                      |

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
hash       01a594946e5e2a9a295ede9938e5b10047594033c00a9d126cec49b39d42702c
successful  true
ledger      4688142
closed      2026-09-15T09:24:57Z
operation   payment  0.1000000 USDC  (payer → receiver)
https://stellar.expert/explorer/testnet/tx/01a594946e5e2a9a295ede9938e5b10047594033c00a9d126cec49b39d42702c
```

### Rejection cases

| Case                                | Response                                                                   |
| ----------------------------------- | -------------------------------------------------------------------------- |
| Replayed hash (same tx twice)       | `402` — _"This payment has already been used. A new payment is required."_ |
| Forged hash (`f`×64, never existed) | `402` — _"Payment verification failed: Transaction not found on chain"_    |

Payment verification is single-use enforced in Redis **and** on-chain, and
unknown hashes fail closed. An unpaid request never reaches the LLM.

### Provider payout — the multisig actually moved funds

The payout leg deploys a threshold-1 multisig, funds it with USDC, then drives
`POST /api/v1/admin/payouts/propose` through real wallet auth. **It passes end
to end**, and the contract transfer is confirmed on-chain:

| Fact                           | Value                                                                                               |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| Multisig contract              | `CBQQSVQAJXWKI7DDNXRY4WR4XGIVDSWJJU4IW2RP5GUAXSHAVPP3RMTL`                                          |
| USDC SAC                       | `CDFNZMPEDWPLMAD5SPLPSBJVZ5QW4L3LK3SIH2EUYAUJCU5JMBWQCKMJ`                                          |
| Proposal (on-chain `executed`) | ids `4`, `5`, `6` — all `executed: true`, queried via RPC `get_proposal`                            |
| Settlement transaction         | `a929c7408413032f28cd01ab9188829889cd9490d722ffa981d09aa555a1139f`                                  |
| Horizon                        | `successful: true`, ledger `4688152`, `invoke_host_function` from `GCF7YNP4…`, 2026-09-15T09:25:47Z |
| Contract balance change        | multisig SAC `67.00 → 66.00` USDC — exactly the 1 USDC proposed                                     |
| `PayoutProposal` row           | `status=executed`, `executedAt` set, `txHash` = the settlement hash above                           |

Look the transaction up yourself at
`https://stellar.expert/explorer/testnet/tx/a929c7408413032f28cd01ab9188829889cd9490d722ffa981d09aa555a1139f`.

Reproduce with `bash scripts/testnet-journey.sh` (the payout leg runs
automatically when the multisig wasm is built).

### Credit-escrow settlement — a per-token route charged **and** refunded on-chain

`bash scripts/testnet-escrow.sh` deploys a **fresh** credit-escrow, has a user
deposit USDC, then drives a **per-token** request through the real gateway with
`X-Escrow-User`. After the response is delivered, the gateway settles the draw
against the contract: `charge` for the metered actual cost, then `refund` for the
unused surplus.

**Result: all checks passed** — 4/4 on-chain assertions. Every number below was
read back from the ledger, not from the script's own arithmetic.

| Fact                     | Value                                                                                 |
| ------------------------ | ------------------------------------------------------------------------------------- |
| Credit-escrow (fresh)    | `CD5VHH3PKR3OKNAFO2ZVSL3OTVUDSUHR66JAQHJE6ZNEDKJ4MNWYZA62`                            |
| USDC SAC                 | `CDFNZMPEDWPLMAD5SPLPSBJVZ5QW4L3LK3SIH2EUYAUJCU5JMBWQCKMJ`                            |
| User (payer)             | `GAEAFNWF72JFBXWGTVQY3AHLYEUDWKJ3SPOSOU5SPJ2H276MJWB2NWDL`                            |
| Admin (signs settlement) | `GDJNUSRNUOM5HI3EU2LLVGVYW6ABWSTDPZSICWILAEUAE65MMM6EXVLP`                            |
| **Charge** transaction   | `ecca64ad9de56f734dd1396d2273ba6951157ed88d9e97f626c61c74ea4c50ea` (ledger `4688785`) |
| **Refund** transaction   | `0a9d68a5244e9f2d2e5336b31059f4a6a48cca424434f2204689570186c01703` (ledger `4688786`) |

Metered arithmetic and the on-chain effects (before → after):

| Quantity                 | Value                                   | Assertion                                    |
| ------------------------ | --------------------------------------- | -------------------------------------------- |
| Route pricing            | `50` stroops/token                      | seeded per-token route                       |
| Deposit estimate (quote) | `204800` (4096 × 50)                    | returned by the `402`                        |
| Tokens used              | `500`                                   | `X-Tokens-Used` header                       |
| Actual cost              | `25000` (500 × 50)                      | `X-Actual-Cost` header                       |
| Surplus                  | `179800` (204800 − 25000)               | `X-Surplus` header                           |
| Contract revenue         | `844200 → 869200` (**+25000**)          | ✅ charge executed — exactly the actual cost |
| Caller escrow balance    | `68976000 → 68771200` (**−204800**)     | ✅ drawn by the full quote                   |
| Caller USDC (SAC)        | `7920179800 → 7920359600` (**+179800**) | ✅ refund executed                           |
| Contract USDC (SAC)      | `69820200 → 69640400` (**−179800**)     | ✅ surplus paid out of held tokens           |

The refund was confirmed independently on Horizon — its effects are
`contract_debited USDC 0.0179800` → `account_credited USDC 0.0179800` to the
caller, which is exactly the `179800` stroop surplus:

```
https://stellar.expert/explorer/testnet/tx/0a9d68a5244e9f2d2e5336b31059f4a6a48cca424434f2204689570186c01703
https://stellar.expert/explorer/testnet/tx/ecca64ad9de56f734dd1396d2273ba6951157ed88d9e97f626c61c74ea4c50ea
```

The settlement is also **auditable from the database**. `Payment.txHash` names the
draw (the synthetic `escrow:<quoteId>`); the charge and refund transactions are
persisted alongside it, so the settlement can be traced without reading logs:

```sql
SELECT "quoteId", "txHash", "settlementTxHash", "refundTxHash"
FROM "Payment" WHERE "txHash" LIKE 'escrow:%';
```

```
 quoteId                              | txHash                                | settlementTxHash                                                 | refundTxHash
 0e9e0628-930e-4440-bf1a-6b5be5240839 | escrow:0e9e0628-…                     | d9722c7a5788c8e5792da38de46ca4fa11cfa36af534b5d48cede22d17a1c810 | aef8c58e5ccfa91dd84fed80ff31fc7ccf0c3b3ebb2e04e96f7237a12caaac95
```

Both were confirmed independently on Horizon (`successful: true`, ledgers
`4688897` and `4688898`); the refund again shows `contract_debited USDC
0.0179800` → `account_credited USDC 0.0179800`.

Note on the upstream: the route points at a public HTTPS **echo** that returns
the posted JSON, and the caller supplies the OpenAI-shaped `usage` (the gateway
schema is `.passthrough()`). That makes the metered cost deterministic and the
evidence reproducible. The same path also works against a real public LLM, but
that provider rate-limits its anonymous tier and intermittently answers HTTP
`200` with `total_tokens: 0`, which cannot serve as reproducible proof.

## 7. Dashboard deployment — not functional

The deployed dashboard is a **stale build**: its client bundle still resolves
the gateway URL to `http://localhost:3000`, so every request targets the
visitor's own machine and the page stays on `Connecting…` / `Loading…`. On top
of that, **no gateway is deployed**, so there is nothing to connect to.

The client-side fix is in `main` (`647441e`) but has not been redeployed. The
Vercel deploy workflow used to skip on a missing `VERCEL_TOKEN` while reporting
**success** — a green no-op; it now fails the job instead, and only skips when
the repository variable `ALLOW_DEPLOY_SKIP=true` is set explicitly. See
`DEPLOYMENT.md` for the required environment (`NEXT_PUBLIC_GATEWAY_URL` in
Vercel, `CORS_ORIGINS` on the gateway, which now defaults to this dashboard's
real origin instead of a foreign disabled app). `NEXT_PUBLIC_*` is inlined at
**build** time, so changing it requires a rebuild.

**Finishing this requires credentials this repository does not contain** — a
Vercel token plus a host for the gateway. Nothing above can be completed from
inside the code.

## 8. Defects found and fixed during verification

These were found by running the system, not by reading it.

| #   | Defect                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence it was real                                                                                                                                                                                         | Status                                                                                                                                                                            |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Soroban signing used the wrong SDK API at 8 call sites.** `tx.signAuthEntries(keypair)` / `tx.sign(keypair)` pass a `Keypair` where an options object is required, and drop the promise. Result: the SDK read `publicKey` _off_ the Keypair and got the unbound method, so no auth entry matched (`NoSignatureNeeded`); `send()` ran unsigned; and the abandoned promise rejected **unhandled**, killing the Node process.                                                                                                | The gateway **died** on `POST /admin/payouts/propose`. Crash message contained the stringified method: `No auth entries for public key "function publicKey() { … }"`                                         | **Fixed** — now uses the SDK's `basicNodeSigner` and awaits. Gateway returns a clean `503` and stays up.                                                                          |
| 2   | Contract could not be funded with XLM via a classic `PaymentOp` — a `MuxedAccount` only carries an ed25519 key, so the contract id named a non-existent account                                                                                                                                                                                                                                                                                                                                                             | `tx_failed` / `op_no_destination`; the native-SAC route then succeeded ([`fe7db954…`](https://stellar.expert/explorer/testnet/tx/fe7db95403995d23e69730caab17f82afd34a0f6081af2872acae9552c7becdd))          | Fixed                                                                                                                                                                             |
| 3   | **SAC derivation omitted the network id**, so it produced a well-formed address with no contract behind it                                                                                                                                                                                                                                                                                                                                                                                                                  | Reproduced the wrong value exactly (`CDF3YSDV…` vs the real `CDLZFC3S…`); RPC returned `Error(Storage, MissingValue)`. Now asked of the `stellar` CLI, which is authoritative                                | Fixed                                                                                                                                                                             |
| 4   | A credit asset's SAC was never deployed, but the journey mints from a fresh issuer each run                                                                                                                                                                                                                                                                                                                                                                                                                                 | `MissingValue` on the USDC transfer; `stellar contract asset deploy` fixed it ([`7135691c…`](https://stellar.expert/explorer/testnet/tx/7135691c20bd02b58056089a85a745b978e181fa8aba22146b4225243f1002cf))   | Fixed                                                                                                                                                                             |
| 5   | `Payment.routeId` referenced a route that was never inserted — a real foreign key                                                                                                                                                                                                                                                                                                                                                                                                                                           | Prisma `P2003 Foreign key constraint violated: Payment_routeId_fkey`                                                                                                                                         | Fixed                                                                                                                                                                             |
| 6   | **Dashboard image could not be built at all** — production stage copied from `dist/apps/dashboard/.next`, but `@nx/next:build` writes to `apps/dashboard/.next`                                                                                                                                                                                                                                                                                                                                                             | `docker build` → `failed to compute cache key: … not found`                                                                                                                                                  | Fixed                                                                                                                                                                             |
| 7   | Dashboard container listened on 3000 while compose/probes/Service all advertise 3001                                                                                                                                                                                                                                                                                                                                                                                                                                        | Standalone `server.js` reads `PORT` → 3000; configmap injected `PORT=3000`                                                                                                                                   | Fixed                                                                                                                                                                             |
| 8   | Shipped `CORS_ORIGINS` allow-listed a _different, disabled_ Vercel app                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `x402-dashboard.vercel.app` returns `DEPLOYMENT_DISABLED`; the real origin appeared nowhere in the repo                                                                                                      | Fixed                                                                                                                                                                             |     | 9   | CI inlining guard built only `--target builder` and asserted a path Nx never produces | Job red for the wrong reason while the real defect sat underneath | Fixed — now builds the full image |
| 10  | **All five on-chain write paths built their transaction against a null account.** `Client.from({…})` omitted `publicKey`, and the SDK's `getAccount` falls back to `new Account(NULL_ACCOUNT, '0')` — so the invocation went out from an all-zero source with sequence 1 and could never be accepted. This affected `record_payment`, `charge`/`refund` escrow **and** the multisig `propose`/`approve`: the entire on-chain settlement surface.                                                                            | `txBadSeq` on the payout leg; the fallback is visible in the SDK at `lib/contract/utils.js` line 115                                                                                                         | Fixed — `publicKey` is now the signing account                                                                                                                                    |
| 11  | **The pinned SDK could not speak the network's protocol at all.** `@stellar/stellar-sdk` was pinned at `12.3.0`; Testnet runs protocol 23+, whose transaction meta the old XDR cannot decode, so **every** submitted transaction failed response parsing. Fixing `#10` did not fix the flow — it only moved the failure from `txBadSeq` to `Bad union switch: 4`.                                                                                                                                                           | Reproduced in isolation against a real contract: SDK 12.3.0 → `Bad union switch: 4` at `rpc/parsers.js:37`; SDK 16.3.0 → transaction submitted (`13b35c9d…`). See §9.                                        | Fixed — upgraded to `^16.3.0` (LTS)                                                                                                                                               |
| 12  | **Execution was inferred from a return value that never exists.** The multisig contract declares `approve(..) -> ()`, but the client did `executed = Boolean(tx.result)`. A threshold-1 payout that the contract had already transferred was recorded as merely `approved`, with `executedAt` never set. The unit test encoded the same wrong assumption (`result: true`), so it passed.                                                                                                                                    | First payout run: on-chain `get_proposal(3).executed == true` while the ledger said `status=approved`, `executed=false`                                                                                      | Fixed — the proposal is read back after approval; the test now covers the real contract shape and fails closed                                                                    |
| 13  | `PayoutProposal.txHash` was never written — the settlement transaction could not be traced from the database.                                                                                                                                                                                                                                                                                                                                                                                                               | Every row had an empty `txHash` despite the column existing                                                                                                                                                  | Fixed — `propose`/`approve` return the submitted hash and both the admin and cron paths persist it                                                                                |
| 14  | The payout harness read SAC balances with a **contract** address as the Horizon source account (`/accounts/C…` → `400`), so every balance read silently returned `null` and the payout assertions could not fail.                                                                                                                                                                                                                                                                                                           | `(SAC balance read failed: Bad Request)`; `multisigSacBefore/After == null` in every earlier evidence file                                                                                                   | Fixed — simulates from the signer account and reads `result.retval` (SDK 16 shape)                                                                                                |
| 15  | The payout harness was not re-runnable: a fixed seed `Payment.txHash` tripped P2002, prior proposals consumed the seeded revenue (`No pending confirmed revenue`), and `BigInt` balances broke `JSON.stringify`.                                                                                                                                                                                                                                                                                                            | Three consecutive failures, one per cause                                                                                                                                                                    | Fixed — seed is upserted and sized to leave exactly 1 USDC payable, and evidence serialization is BigInt-safe                                                                     |
| 16  | **The escrow balance read silently returned `0` for every funded account.** In stellar-sdk 16 a read call resolves to an `AssembledTransaction`, so the balance lives on `.result`; the code passed the whole transaction object to `i128ToString`, which read `obj.lo ?? 0n` / `obj.hi ?? 0n` and coerced it to `0`. Because `0` is indistinguishable from an empty account, **every** escrow-funded request was rejected with `insufficient balance: 0 < 204800` — the feature was wired but could never serve a request. | The gateway logged `[escrow] Balance read { balance: "0" }` while the contract returned `10000000` for the same address; the SDK's own type declarations show `balance()` returns an `AssembledTransaction`. | Fixed — reads `tx.result`; `i128ToString` now **throws** on an unrecognised shape instead of coercing to `0`. Four tests pin the SDK 16 read shape and the fail-closed behaviour. |

### Why the tests missed #1

The specs mocked `signAuthEntries` / `sign` as bare `jest.fn()`s on a fake
keypair, encoding the _wrong_ API contract — so they passed regardless. They now
use a **real `Keypair`** and the real `basicNodeSigner`, so the path is actually
exercised.

### Why the tests missed #16

`getEscrowBalance` had **no test at all**. The escrow spec covered `charge`,
`refund` and `settleEscrow`, and every e2e mocked the balance read away — so the
read path was never executed against anything, and the `?? 0n` default made the
wrong shape look like a legitimate zero. It is now covered for the real SDK 16
shape (`.result`), the `lo`/`hi` parts shape, and an unrecognised shape (which
must fail closed rather than report `0`).

## 9. Not verified

Recorded deliberately, so nothing here is mistaken for a working feature.

1. **Escrow settlement is now verified on Testnet** (§6) — a per-token route
   charged the metered cost and refunded the surplus, both transactions
   confirmed on Horizon and persisted to the `Payment` row (`settlementTxHash`
   / `refundTxHash`). What is _not_ verified is escrow under concurrent load,
   or a refund that fails after a successful charge (the code logs that as an
   error; no live failure was injected).
2. **No public deployment.** No gateway is hosted; the dashboard URL is stale.
   Nothing about the deployed system is verified. This is blocked on
   credentials, not on code — see §7.
3. **Failure-injection cases** (Postgres/Redis/RPC down, LLM provider failure,
   network interruption) are exercised only by unit tests with mocked
   dependencies — not against a live stack.
4. **Webhook and email delivery** are unit-tested, not delivered to a real
   external receiver. SSE receipt streaming is covered by e2e tests, not by a
   browser.
5. **No external security audit.** Contracts are self-tested only.
6. **Python/LangChain SDK** is tested against mocks, not against live Testnet.

### Why the SDK mattered more than it looked

Nothing in the on-chain write path had ever succeeded, and that was invisible
because these calls are wrapped in best-effort `try/catch` blocks that log a
warning and continue. A payment still returned `200`, a dashboard still
rendered, audit rows were still written — the on-chain half quietly did
nothing.

Three defects had to be fixed in sequence before the real blocker became
visible, and each was only found by running the flow against live Testnet:
the signing API misuse (§8 #1), then the null source account (§8 #10), then the
SDK/protocol mismatch (§8 #11). **The `txBadSeq` error was the second of three
causes, not the cause** — a fix that stopped at it would have looked correct and
still never settled a payment.

## 10. Verifying this document yourself

```bash
git clone https://github.com/mallonepay/pay-per-token-llm-gateway.git
cd pay-per-token-llm-gateway
pnpm install --frozen-lockfile && pnpm test && pnpm lint
for c in payment-verifier credit-escrow multisig; do (cd contracts/$c && cargo test); done
bash scripts/testnet-journey.sh     # main journey AND payout leg green
bash scripts/dashboard-e2e.sh       # all checks pass
```

Then look up any hash in §6 or §8 at
`https://stellar.expert/explorer/testnet/tx/<hash>`. Testnet funds have no
value; no mainnet transaction is claimed anywhere in this repository.
