# Changelog

All notable changes to the x402 LLM Gateway project.

---

## [Unreleased] — 2026-09-13

### Security

- **Contract initialization is now atomic (C11 fixed).** `stellar contract
deploy` and a separate `init` call are two different transactions, so anyone
  could previously initialize a freshly deployed contract first with their own
  `admin` (payment-verifier, credit-escrow) or their own single-signer set
  (multisig) — taking ownership of a contract the deployer had just created.
  The re-init guard in each contract covered the _second_ call, not the first.
  All three contracts now initialize in a Soroban `__constructor`, which
  executes **inside** the deploy transaction, and the `init` entry point was
  **removed** so no post-deploy initialization path exists at all. This also
  removes the "deployed but never initialized" failure mode: a contract whose
  constructor rejects its arguments now fails the deploy outright.

  Note that the obvious fix — `admin.require_auth()` on `init` — would **not**
  have worked: the address is a caller-supplied parameter, so an attacker names
  _and signs_ their own, and `require_auth` only proves control of the address
  the caller supplied, never that they are the deployer.

  This is a **deploy-ABI change**: `scripts/deploy-contracts.sh` now passes
  each contract's constructor arguments to `stellar contract deploy`
  (`-- <args>`) instead of calling `init` afterwards, and all three contract
  test suites were migrated to `env.register(Contract, (<constructor args>))`.
  Because there is no on-chain state to migrate, the next deployment simply
  uses the new path. All 111 contract tests pass (29 / 46 / 36) and the WASM
  artifacts build to 7–9 KiB against the 64 KiB deploy limit. See `SECURITY.md`
  (residual risk 9), `THREAT-MODEL.md` (C2/C11) and `MAINNET_READINESS.md`
  §5/§6.

- **SSRF redirect bypass closed.** The public-IP validation for webhook URLs
  and upstream LLM URLs was performed on the _initial_ destination, but no
  `fetch` in the repository set `redirect`, so undici's default behaviour
  followed a `3xx` to internal infrastructure (e.g. `169.254.169.254`) after
  the check had passed — and for routes the redirect body is returned to the
  caller. Both proxy fetches and both webhook deliveries now use
  `redirect: 'error'`.
- **Webhook delivery timeout:** the plain `WebhookNotificationHandler.send()`
  path had no `AbortSignal`, so a receiver that never responded could hold the
  `/webhooks/test` request open unboundedly; both delivery paths now time out
  after 10 s.
- **Dependency advisories cleared and the scan is now a gate.** `js-yaml`
  4.3.1 → 5.4.1 and `smol-toml` 1.6.1 → 1.8.0 (new `pnpm-workspace.yaml`
  override floors); in `python/uv.lock` `urllib3` 2.6.3 → 2.7.0,
  `langchain-core` 0.3.86 → 1.6.3, `langsmith` 0.4.37 → 0.12.4, `requests`
  2.32.5 → 2.34.2, `orjson` 3.11.5 → 3.12.0 and `pytest` 8.4.2 → 9.1.1. The
  PyPI packages were each pinned **twice** — a patched pin for 3.10+ and an
  unpatched one for the `>=3.9` branch — so `python/pyproject.toml` now
  requires Python `>=3.10` (3.9 is EOL with no patched releases) and the lock
  resolves as a single branch; 47/47 SDK tests pass on the new pins.
  osv-scanner: **28 → 15** advisories; Trivy fs: **0 HIGH/CRITICAL**.
- The osv-scanner CI job no longer swallows its exit code. Findings that are
  not explicitly reviewed in the new `.osv-scanner.toml` now **fail the
  build**, and every exception there carries a reason and an `ignoreUntil`
  expiry. The remaining 15 are the advisories with no patched release at any
  version (`image-size` ×2, `adm-zip`, `paste`, `derivative`) and the crates
  pinned by the Soroban SDK the contracts build against
  (`soroban-env-host`, `stellar-xdr`) — see `MAINNET_READINESS.md` §7.
- **Explicit `TRUST_PROXY`:** the Express `trust proxy` setting is now
  **disabled by default** (forwarding headers ignored) instead of defaulting to
  `1`. A directly-exposed gateway can no longer be tricked into honouring a
  forged `X-Forwarded-For`; production starts log a warning when it is unset.
  Set `TRUST_PROXY=1`/`loopback`/a proxy IP list only behind a real proxy.
- **Wallet-based rate limiting:** the paid tier is now keyed by the
  server-verified payer wallet on the confirmed payment row, not the client IP,
  so rotating source addresses cannot mint fresh buckets. Unpaid requests
  remain per-IP.
- **Payout concurrency:** proposal creation is serialised per provider across
  gateway instances and across the admin API, so a multi-replica deployment (or
  a retried request) cannot commission two payouts for the same revenue. See
  the `Fixed` entry below for the failure this closes.
- **Payout hardening:** payout automation validates `payoutWalletAddress` with
  `StrKey.isValidEd25519PublicKey`, re-checks provider approval/active state at
  proposal time, and refuses to pay when the destination changed. The
  threshold-1 auto-approve now derives the signer address from the signing key
  and records the real approver.

### Fixed

- **Payout proposals can no longer be double-proposed.** `pendingRevenue` is a
  read-modify-write against the `PayoutProposal` ledger whose write lands
  several awaited steps after the read (a Soroban round-trip). Two writers
  interleaving inside that window both observe the same `alreadyReserved` and
  both reserve the whole balance; with a threshold-1 wallet both proposals
  auto-execute, paying the provider twice for one revenue stream. There are two
  writers: `PayoutsService`'s daily `@Cron`, which NestJS fires in **every**
  replica — `infrastructure/kubernetes/gateway.yaml` runs 2, and its README
  invites raising that — and `AdminService.proposePayout`, which a
  double-submitted or client-retried admin request hits twice. Both now take a
  **per-provider Redis lock** (`x402:lock:payout-propose:<providerId>`) around
  the read→reserve→propose sequence, so they exclude each other and unrelated
  providers stay independent. Fail-closed: if the lock cannot be taken (Redis
  unreachable) the proposal is refused — a skipped provider loses nothing
  because its revenue stays `confirmed`, whereas a duplicate proposal moves
  money that no revenue backs. `AdminService` returns 409 when a proposal for
  the same provider is already in flight.
- **Credit-escrow settlement now actually settles — exactly once.** Three
  defects in the `#25` wiring meant the documented behaviour did not hold:
  (1) an escrow draw was pre-charged by `chargeEscrowOnChain` before
  `settleEscrow` ran, so the contract's per-quote idempotency guard made the
  settlement charge fail and the **surplus was never refunded**;
  (2) a flat-rate route settled through the escrow payment path was never
  debited at all, giving a funded caller unlimited free requests;
  (3) every metered Horizon payment was settled against the caller's escrow
  balance too, double-billing wallets that held one. Escrow settlement is now
  a single call site, applies to escrow-funded draws (`X-Escrow-User`) for
  both flat-rate and per-token routes, and never touches escrow for a
  Horizon-paid request. The e2e suite now asserts the balance is consumed
  (previously it passed even when nothing was charged).
- **Payout automation no longer re-proposes committed revenue.** Pending
  payout revenue was computed as `confirmed − executed`, so an M-of-N proposal
  awaiting signer approvals (threshold > 1) did not reserve its revenue and
  the daily run minted a new proposal for the same money every day — two
  approvals could have paid a provider twice. In-flight proposals
  (`pending`/`proposed`/`approved`) now reserve revenue in both the cron and
  the admin endpoint (`PAYOUT_RESERVING_STATUSES`).
- **Prisma migration drift reconciled.** `schema.prisma` declared
  `@@unique([txHash])`, but the migration created only a _partial_ unique
  index, so `prisma migrate diff` reported permanent drift and `prisma db
push` produced a different database than `prisma migrate deploy`. The
  canonical full unique index now matches the declared schema; the single-use
  guarantee is unchanged (verified against a real Postgres).
- **`amountToScVal` now encodes the full i128 range.** It packed the whole
  value into the low word and hardcoded `hi = 0`, so any amount ≥ 2^64 threw
  or encoded incorrectly. The value is now split into low/high 64-bit words
  with an explicit `i128` upper bound.
- **`X-Payment-Receipt` now actually carries the route.** #46 populated the
  route in the persisted `receiptJson`, but the returned header (and the
  streaming `x402_receipt` event) omitted the field entirely — the acceptance
  criterion required both. All receipt payloads now include `route`, with e2e
  assertions.
- **Paid retry now succeeds end to end.** `POST /api/v1/chat/completions` with a
  valid `X-Payment-Hash` previously returned `402 "Payment was made before the
quote was issued"`. At retry time no `Payment` row carried the hash yet (the
  quote's row was still `pending` with `txHash = NULL`), so verification minted
  a **new** quote and validated the payment timestamp against it — always
  rejecting a payment made before that new quote. The quote memo is a
  deterministic function of the quote id, so the gateway now resolves the
  originating quote from the transaction's on-chain memo
  (`PaymentsService.findPendingByQuoteMemo` + `X402Service.fetchTransactionMemo`)
  and binds the payment to the exact quote window it paid for. Payments with no
  resolvable quote are still rejected by the fresh quote's `issuedAt` lower
  bound — fail-closed. Covered by new unit tests (`quoteMemo` /
  `quoteIdPrefixFromMemo`, `findPendingByQuoteMemo`) and two e2e cases;
  `scripts/testnet-journey.sh` now passes its `HTTP 200` step.
- **Live payout-leg deploy updated for the constructor ABI.**
  `scripts/testnet-payout.ts` deployed a fresh multisig with raw SDK operations
  and then called the `init` entry point — which the atomic-initialization
  change removed, so the payout leg of the live journey would have failed at
  deploy. It now deploys through the `stellar` CLI with the constructor
  arguments (`-- --signers … --threshold 1 --token …`), the same mechanism as
  `scripts/deploy-contracts.sh`; the bundled `@stellar/stellar-sdk` 12.x
  predates the protocol-23 `CREATE_CONTRACT_V2` host function, so it cannot
  carry constructor arguments from TypeScript. `scripts/testnet-journey.sh`
  now lists the CLI as a requirement of that leg.
- **Video forged-hash demo:** the capture used a hardcoded `f`×64 hash, which
  replay protection claimed on first sight, so later captures reported
  "Payment already used" instead of the intended fail-closed
  "Transaction not found on chain". Captures now use a random unseen hash.
- **SSE payment receipts are now reliable:** the upstream `data: [DONE]`
  sentinel is withheld and re-emitted _after_ the trailing `x402_receipt`
  event, so clients that stop at `[DONE]` still receive the receipt; the SDK
  drains past `[DONE]` and exposes the final receipt via lazy getters.
- **SQL time-series analytics:** window starts are aligned to the interval
  grid, so aggregated rows are no longer silently dropped for the (usual)
  unaligned wall-clock time.
- **Escrow draws:** each draw now carries a unique `escrow:<quoteId>`
  synthetic hash, so a second escrow request no longer collides with the unique
  `Payment.txHash` index and per-token settlement actually runs.
- **Circuit breaker:** an unexpected (non-`open:<n>`) Redis reply no longer
  fast-fails every request against a healthy upstream.
- **Dashboard `cn()`:** now actually merges classes via `twMerge(clsx(...))`
  instead of a naive `join(' ')`, so conflicting Tailwind utilities resolve as
  the call sites (and tests) intend.
- **Dashboard test target:** wired `nx test dashboard` (and added the
  `jest-environment-jsdom` the config already required) — the existing spec
  files were previously never executed in CI.

### Added

- **`schema-drift` CI job:** applies the Prisma migration history to an empty
  Postgres and runs `prisma migrate diff --exit-code`, so a declared-but-not-
  materialised constraint can never silently diverge from the migrations
  again. Also removed the `Wallet`/`PrepaidCredit` seeds from
  `scripts/backup-restore-drill.sh` and `video/seed-demo.sql` (the models are
  gone); the drill was re-run end to end and passes 14/14.
- **Product pitch video** (`docs/media/x402-gateway-demo.mp4`, 1080p, ~5 min)
  with thumbnail, burned-in captions, an `.srt` and a synthesized voice-over,
  featured in the README. It
  is rendered from a deterministic stage fed by assets captured from a live
  gateway + dashboard, and now shows the full paid flow: a real Stellar testnet
  USDC payment, a `200` with payment receipt, then replay and forged-hash
  rejection. Pipeline and provenance: `video/README.md`.
- **Provider-agnostic narration:** `video/make-voiceover.mjs` synthesizes the
  voice-over with ElevenLabs, OpenAI, Cartesia or Gemini (all normalized to
  24 kHz mono), or entirely locally with piper when no API key is available, and
  muxes it onto the video. Each cue is synthesized and placed at its own caption
  time, so a caption changes exactly when its line starts being spoken.
- **`pnpm video:check`** (and a `Video Narration Timing` CI job) fails the build
  when any narration cue would overrun the scene budget it is spoken over.
- **Persisted in-app notifications:** `POST/GET /api/v1/notifications` backed
  by a Postgres `Notification` row (with `read`/`readAt` state), plus a
  dashboard `/notifications` feed with read controls. Migration
  `20260912000000_notification_read_state`.

### Tests

- New coverage for wallet-keyed rate limiting, payout validation/approval,
  escrow hash uniqueness, notification persistence, analytics bucket
  alignment, SSE receipt ordering, and the `minPaymentAmount` floor.

---

## [0.2.0] — 2026-09-08

### Security

- **Quote-window integrity:** `issuedAt` added to `Quote`; payments made
  before quote issuance are rejected (prevents replay of pre-issuance txs)
- **Network timeouts:** config-driven `HORIZON_TIMEOUT_MS` /
  `SOROBAN_RPC_TIMEOUT_MS` wired through x402-core and contract clients
- **Redis fail-fast:** bounded retry strategy + connect timeout so a down
  Redis fails startup instead of hanging forever
- **Dependency posture:** NestJS 10 → **11.2.3** (Express 5.2.1, multer
  2.2.0), Next 14 → **15.5.25** (React 19), **nx 19.5 → 22.7.9**
  (eslint-config-prettier 10), plus overrides for express/ws/body-parser/qs/
  uuid/lodash/js-yaml/toml/postcss/file-type/minimatch/serialize-javascript/
  fast-uri/adm-zip — **0 critical, 0 runtime-reachable advisories**; the 9
  dev-tooling advisories dropped to **2 high** with the nx 22 migration, both
  `image-size` (via the unused @nx/vite→less chain; no patched release exists)
  — see `MAINNET_READINESS.md` §7
- **Build fix:** the nx 22 tree pulled `supports-color@7.2.0` into the
  `@babel/core` peer chain, splitting `next` into two store instances (root
  `.bin/next` vs `apps/dashboard` resolved different copies, breaking the
  pages-router `/404` prerender with the `<Html>` context error); pinning
  `supports-color: 8.1.1` collapses the tree to one instance — `next build`
  green again
- **Input validation:** message/content bounds hardened in `@x402/validation`

### Observability & operations

- **Prometheus `/metrics`** endpoint with HTTP request counters/durations,
  provider, debt, and circuit-breaker metrics + Grafana dashboard
- **Liveness/readiness:** `/health/live` and `/health/ready` with real
  Postgres/Redis dependency checks (503 when unhealthy)
- **Streaming backpressure** in proxy stream forwarding
- **Docker hardening:** non-root users, healthchecks, OCI labels
- **CI/CD:** gitleaks, trivy, osv-scanner, SBOM (CycloneDX) jobs; pnpm 11
  migration (workspace `allowBuilds`/`overrides`)

### Docs

- New: `ARCHITECTURE.md`, `THREAT-MODEL.md`, `API.md`, `GAS-OPTIMIZATION.md`,
  `OPERATIONS.md` (RTO/RPO, backup/DR), `OBSERVABILITY.md`; rewritten
  `AUDIT.md`; updated `SECURITY.md` / `DEPLOYMENT.md` /
  `MAINNET_READINESS.md` / `README.md`

---

## [0.1.0] — 2026-08-11

### Added

- **Gateway:** Reverse proxy with HTTP 402 Payment Required flow for LLM APIs
- **Gateway:** Flat-rate and per-token pricing models with metered billing
- **Gateway:** Triple-layered replay protection (Redis SET NX → on-chain contract → DB unique constraint)
- **Gateway:** SSRF guards for webhook and upstream URLs with DNS resolution
- **Gateway:** Rate limiting (paid/unpaid tiers, sliding-window Redis Lua script)
- **Gateway:** Circuit breaker for upstream LLM failures
- **Gateway:** Streaming (SSE) support for chat completions
- **Gateway:** Multi-tenant isolation — all data scoped by authenticated wallet
- **Gateway:** Audit logging of all gateway operations
- **Gateway:** Webhook notifications with HMAC signatures and retry logic
- **Gateway:** Wallet-based authentication (challenge-response with Stellar keys)
- **Gateway:** Escrow settlement via credit-escrow Soroban contract (charge + refund)
- **Dashboard:** Next.js provider dashboard with route/payment management
- **Dashboard:** Real-time analytics (summary, time series, top callers/routes)
- **Dashboard:** Wallet authentication (Freighter, xBull, Albedo)
- **SDK:** TypeScript client with automatic 402 → pay → retry flow
- **SDK:** Streaming support via async generators
- **SDK:** External wallet signing (publicKey + signTransaction)
- **Contracts:** Payment Verifier — on-chain payment recording with replay protection
- **Contracts:** Credit Escrow — prepaid balance management with idempotent charge/refund
- **Contracts:** Multisig Wallet — M-of-N signer approval for provider payouts
- **CI/CD:** Lint → unit tests (coverage thresholds) → E2E → contract tests → security audit
- **CI/CD:** Docker images for gateway and dashboard
- **CI/CD:** Railway + Vercel deployment configs
- **Docs:** README, DEPLOYMENT.md, SECURITY.md, CONTRIBUTING.md, AUDIT.md

### Fixed (from audit — Phase 1)

- **C2:** SDK external signer path now works (`publicKey` + `signTransaction`)
- **C5:** Streaming responses now include receipt/cost as trailing SSE event
- **M2:** `minPaymentAmount` enforced in quote generation and payment verification
- **M4:** RateLimitGuard added to PaymentsController public status endpoint
- **C1:** Escrow settlement wired into proxy controller (charge + auto-refund surplus)

### Fixed (from audit — Phase 2)

- **M6:** DNS rebinding protection added at proxy-forward time (`813fed7`)
- **M10:** Email notification channel wired with nodemailer (`09e4706`)
- **L9:** Jest unit test scaffolding added for dashboard pages and components (`05e10c9`)
- **M3:** Credit-escrow invariant tests added for balance equation (`b49a2d1`)
- **L4:** CHANGELOG.md, git tags, and release cadence established
- **L2:** `contracts/deployed-addresses.json` committed and tracked

### Known Limitations (as recorded at the 0.1.0 release)

> Kept for historical accuracy, not as a current status. Four of these were
> fixed in the [Unreleased] section above and are struck through here so the
> two sections cannot be read as contradicting each other.

- Circuit breaker is in-memory only (not shared across gateway instances) —
  **still true today**; tracked in
  [`MAINNET_READINESS.md`](./MAINNET_READINESS.md).
- ~~SDK unit tests remain at 0% coverage
  ([#45](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/45))~~
  — **resolved**; `packages/sdk` now has a Jest target with a suite covering
  the `call`/`callStream`/signer paths.
- ~~Escrow settlement is partially wired (credit-escrow contract exists but
  gateway settlement path is incomplete —
  [#25](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/25))~~
  — **resolved**; a single settlement call site charges the actual cost and
  refunds the surplus (see [Unreleased] → Fixed).
- ~~Streaming receipt headers are not yet set (`X-Payment-Receipt` empty on SSE
  — [#29](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/29))~~
  — **resolved**; the gateway emits a trailing `x402_receipt` SSE event and the
  SDK reads past `[DONE]` to surface it.
- ~~API key / session tables in Prisma schema are dead code —
  [#47](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/47)~~
  — **resolved**; both models are dropped
  (`20260812000000_remove_session_apikey_models`), and the later dead
  `Wallet`/`PrepaidCredit` models were dropped too
  (`20260913000000_remove_unused_wallet_prepaidcredit`).
