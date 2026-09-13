# Changelog

All notable changes to the x402 LLM Gateway project.

---

## [Unreleased] — 2026-09-13

### Security

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
- **Payout hardening:** payout automation validates `payoutWalletAddress` with
  `StrKey.isValidEd25519PublicKey`, re-checks provider approval/active state at
  proposal time, and refuses to pay when the destination changed. The
  threshold-1 auto-approve now derives the signer address from the signing key
  and records the real approver.

### Fixed

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

### Known Limitations

- Circuit breaker is in-memory only (not shared across gateway instances)
- SDK unit tests remain at 0% coverage (targeted as [#45](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/45))
- Escrow settlement is partially wired (credit-escrow contract exists but gateway settlement path is incomplete — [#25](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/25))
- Streaming receipt headers are not yet set (`X-Payment-Receipt` empty on SSE — [#29](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/29))
- API key / session tables in Prisma schema are dead code — [#47](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/47)
