# 🔍 Engineering Audit Report — x402 LLM Gateway

**Audited:** `mallonepay/pay-per-token-llm-gateway` — Soroban contracts
(`payment-verifier`, `credit-escrow`, `multisig`), NestJS gateway, Next.js
dashboard, TypeScript SDK, 14 shared packages, CI/CD, Docker.
**Date:** 2026-09-08 · **Method:** full source review of every
security-critical path + live execution of the test/typecheck/build/audit
matrix in this session (evidence in §0).

---

## 0. Verification evidence (what was actually run)

| Check                                                               | Result                                                                                                                                                                                                                             |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install` (pnpm 11.24, frozen-lockfile-compatible)             | ✅ Fixed — was **broken** (see F1)                                                                                                                                                                                                 |
| Gateway unit tests                                                  | ✅ **127/127** (10 suites)                                                                                                                                                                                                         |
| Gateway e2e (`x402-flow.e2e-spec.ts`)                               | ✅ **34/34**                                                                                                                                                                                                                       |
| `x402-core` tests (incl. new quote-window, timeout, property-based) | ✅ **66/66** (3 suites)                                                                                                                                                                                                            |
| `@x402/validation` tests (new suite + project test target)          | ✅ **25/25**                                                                                                                                                                                                                       |
| SDK tests                                                           | ✅ **15/15**                                                                                                                                                                                                                       |
| Full `nx run-many --target=test --all --coverage`                   | ✅ 6 projects green, coverage gates enforced                                                                                                                                                                                       |
| Gateway typecheck (`tsc -p apps/gateway/tsconfig.app.json`)         | ✅ 0 errors                                                                                                                                                                                                                        |
| Lint (`nx run-many --target=lint --all`, 15 projects)               | ✅ 0 errors                                                                                                                                                                                                                        |
| `pnpm audit`                                                        | ✅ **0 critical, 0 runtime-reachable**; 54 → **2 high** after the NestJS 11 / Next 15 + nx 22 major upgrades, both `image-size` (no patched release, unused vite/less chain — see F8)                                              |
| Secret scan (grep for keys/private keys across repo)                | ✅ none found                                                                                                                                                                                                                      |
| Soroban contracts (`cargo test`)                                    | ✅ **25 / 44 / 33 pass locally** (Rust 1.98.1 + soroban-sdk 22, incl. the new gas/storage benches); WASM sizes 6.6 / 8.5 / 6.9 KiB — see GAS-OPTIMIZATION §5.5                                                                     |
| Live Stellar Testnet journey (stellar CLI 28, fresh funded account) | ✅ all 3 contracts deployed + initialized; `record_payment` live, **replay rejected** (VM trap), `is_payment_used=true`, multisig propose→approve (quorum, fail-closed transfer), escrow balance=0 — evidence in DEPLOYMENT §6.1.1 |

---

## 1. Findings fixed in this pass

### F1 — Blocker: pnpm workspace config broken for pnpm ≥ 10/11

`pnpm-workspace.yaml` contained an `allowBuilds` block with literal
`set this to true or false` placeholders, and the `pnpm` field in
`package.json` (overrides + `onlyBuiltDependencies`) is **ignored by pnpm
11** — so `pnpm install` errored (`ERR_PNPM_IGNORED_BUILDS`), the `koa`
override silently didn't apply, and CI's `PNPM_VERSION: latest` (deploy
workflow) was broken. Dockerfiles pinned pnpm 9 while CI deploy used latest.

**Fix:** migrated settings to `pnpm-workspace.yaml` (`allowBuilds` booleans
for the 7 packages that legitimately run install scripts + `overrides`),
removed the dead `pnpm` field, pinned CI (`ci.yml` → `11`,
`deploy.yml` → `11`) and both Dockerfiles (`corepack prepare pnpm@11`).
`pnpm install` is green.

### F2 — Payment-window integrity: historical-hash reuse (quote lower bound)

`verifyStellarPayment` only rejected payments made **after** quote expiry.
A payment made **before** the quote was issued (any historical payment to the
provider's address — public on Horizon) could be presented against a fresh
quote for one free access; the single-use guards only stop _re_-use, not
first use of an old hash.

**Fix:** `Quote` now carries `issuedAt` (set at generation, `expiresAt =
issuedAt + window`); verification rejects `txTime < issuedAt`
(`Payment was made before the quote was issued`) while skipping the check
defensively for legacy stored quotes. Tested (3 new cases incl. the exact
boundary and backward-compat).

### F3 — No timeouts on Horizon/Soroban fetches

Every chain fetch was a bare `fetch` — a hung Horizon/RPC held request
handlers open indefinitely (worker exhaustion).

**Fix:** `AbortSignal.timeout` on every Horizon fetch in `verifyStellarPayment`
and every Soroban RPC call (`contract-client`), config-driven
(`HORIZON_TIMEOUT_MS` / `SOROBAN_RPC_TIMEOUT_MS`, default 10 s), plus
server-level `requestTimeout`/`headersTimeout`. Tested with an
abort-signal-honoring mock.

### F4 — Streaming backpressure

`res.write(value)` ignored backpressure — a slow consumer made the gateway
buffer the entire upstream stream in memory.

**Fix:** `write() === false` → await `drain`/`close` (with a test-safe
fallback). All 18 proxy-service tests green.

### F5 — Request-size / memory bounds

Body cap existed (1 MB) but the zod schema allowed unbounded message arrays /
content / `max_tokens`.

**Fix:** `≤ 128 messages`, `≤ 64 KiB content`, `max_tokens ≤ 1,000,000`.
Tested (boundary + rejection cases).

### F6 — Health: liveness vs readiness missing

`/health` was a static 200 — no dependency checks, so orchestrators could not
drain a gateway with a dead DB/Redis.

**Fix:** `/health` + `/health/live` (liveness) and `/health/ready`
(Postgres `SELECT 1` + Redis `PING`, **503** with per-dependency detail).
Tested (4 cases). Docker HEALTHCHECK added to both images.

### F7 — Observability: no metrics endpoint

No Prometheus surface existed.

**Fix:** `GET /metrics` (outside the `api/v1` prefix) via a new
`MetricsService` (prom-client): `http_requests_total`,
`http_request_duration_ms`, `x402_quotes_generated_total`,
`x402_payments_verified_total`, `x402_payment_verification_failed_total`,
`x402_upstream_failures_total`, `x402_upstream_retries_total`,
`x402_circuit_breaker_opens_total`, `x402_underpayment_debts_recorded_total`,
`x402_onchain_record_failures_total` + default Node metrics. Instrumented the
quote/verify/forward/debt hot paths; a global interceptor records every HTTP
request. Tested. Grafana dashboard JSON included (`docs/dashboards`).

### F8 — Dependency posture: 0 critical, 0 runtime-reachable

`pnpm audit`: **76 advisories (34 high, 36 moderate)** at baseline. Phase 1
(overrides in `pnpm-workspace.yaml` — real, installable patched versions):
`express ≥5.2.1`, `ws ≥8.21.0`, `body-parser ≥1.20.6`, `qs ≥6.16.0`,
`uuid ≥11.1.1 <12` (12+ is ESM-only — would break the CJS NestJS
integration), `lodash ≥4.18.1`, `js-yaml ≥4.3.1`, `toml ≥4.2.0`,
`postcss ≥8.5.23`, `file-type ≥21.3.2`, `minimatch ≥9.0.7`,
`serialize-javascript ≥7.0.5`, `fast-uri ≥3.1.6`, `adm-zip ≥0.6.0`.
Phase 2 (major upgrades, 2026-09-08): **NestJS 10 → 11.2.3** (Express
5.2.1; platform-express ≥11.1.28 pins **multer 2.2.0**, lifting the ESM/CJS
blocker) and **Next 14 → 15.5.25** (React 19, recharts 2.15.4). Result:
**2 high advisories (0 critical, 0 runtime-reachable)** — remaining are
dev/build-tooling only, both `image-size` (no patched release exists; unused
`@nx/vite`→less chain). The nx 22 migration (2026-09-08) cleared the `nx`
19.5.7 / `webpack-dev-server` 4 / `brace-expansion` tracks.

Follow-up (2026-09-09): osv-scanner surfaced **multer <2.3.0 DoS CVEs**
(CVE-2026-77037/77078/82333, runtime via platform-express) and **svgo 3.3.4
ReDoS** (build-tooling via @svgr/plugin-svgo) — both fixed with installable
patched releases via new `pnpm-workspace.yaml` overrides (`multer >=2.3.0`,
`@svgr/plugin-svgo>svgo >=3.3.5`). Tracks: `MAINNET_READINESS.md` §7.

### F9 — CI security pipeline

Added: **gitleaks** (secret scan over full history, fail-on-leak),
**trivy** fs scan (HIGH/CRITICAL → SARIF → GitHub Security tab),
**osv-scanner** (npm + Cargo.lock), **SBOM** (CycloneDX) attached to every
`v*` release, `pnpm audit` upgraded to a documented critical gate with a
non-blocking high+ report. Install scripts now governed by the
`allowBuilds` allowlist.

### F10 — Container hardening

Both Dockerfiles: run as **non-root** (`USER node`), `HEALTHCHECK` on
`/health` (gateway) and `/` (dashboard), OCI provenance labels. Consistent
pnpm 11 across Docker + CI.

### F11 — Documentation (new)

`ARCHITECTURE.md`, `THREAT-MODEL.md`, `GAS-OPTIMIZATION.md`, `API.md`,
`OPERATIONS.md` (RTO/RPO, backup/restore, DR, runbooks), `OBSERVABILITY.md`
(+ Grafana dashboard), updated `SECURITY.md` / `DEPLOYMENT.md` /
`MAINNET_READINESS.md` / `README.md`.

---

## 2. Findings that required judgment (left as-is, documented)

| #   | Finding                                                 | Decision                                                                                                                                                                                                                     | Where                                                                   |
| --- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| J1  | ~~Next 14 → 15 / NestJS 10 → 11 major upgrades~~        | **DONE 2026-09-08** — NestJS 11.2.3 (Express 5.2.1, multer 2.2.0) + Next 15.5.25 (React 19); all gateway unit/e2e + dashboard build green                                                                                    | resolved; remainder is the nx 22 toolchain track (MAINNET_READINESS §7) |
| J2  | ~~Soroban gas/storage benchmarks~~                      | **DONE 2026-09-08** — Rust toolchain installed (1.98.1), `src/bench.rs` per contract measures fee/entries at 1→1k/10k history and asserts the O(1) gate; results ledger in GAS-OPTIMIZATION §5.5; WASM size gate added to CI | GAS-OPTIMIZATION.md §5.5; CI `contracts` job (benches + size gate)      |
| J3  | Rate limiting is IP-only                                | Accepted residual; the confirmed-payment tier cannot be spoofed by headers; single-use enforcement is the backstop                                                                                                           | SECURITY.md residual 2                                                  |
| J4  | Escrow settlement opt-in/experimental (fire-and-forget) | Product decision; disabled for mainnet v1                                                                                                                                                                                    | MAINNET_READINESS §5                                                    |
| J5  | Third-party contract audit                              | **The** mainnet gate — a trust decision, not technical                                                                                                                                                                       | MAINNET_READINESS §1                                                    |

---

## 3. Verified security invariants (regression-anchored)

Each invariant below has automated tests that fail if it regresses:

1. **Single-use payments** — same hash twice → second 402 (Redis `SET NX`
   race + DB unique + on-chain `USED_TX`); concurrent claim losers get
   `null`.
2. **Quote window** — payment before `issuedAt` or after `expiresAt` → 402.
3. **Underpayment enforcement** — per-token deposit ≤ payment; actual cost
   metered; deficits recorded as open per-(payer, provider) debt; access
   gated until a top-up covering deposit + debt clears the ledger.
4. **Asset/issuer exactness** — wrong asset, wrong issuer, wrong recipient,
   native-vs-USDC, path-payment refusal on mainnet policy.
5. **Amount math** — stroop↔unit round-trips under 500 randomized inputs per
   property; quote clamping ≥ `MIN_PAYMENT_AMOUNT`; price arithmetic
   identities.
6. **Auth** — challenge single-use/expiry, JWT issuer+secret, session store,
   provider-scoped multi-tenancy on every query, `AUTH_DEV_MODE`
   production boot-refusal, mainnet network-consistency boot guard.
7. **SSRF** — public-IP-only upstreams/webhooks (DNS-resolved, IPv4+IPv6,
   private/CGNAT/metadata ranges), DNS-rebind re-validation at proxy time,
   webhook re-validation at delivery.
8. **Contracts** — admin auth on all mutators, double-init rejection,
   multisig rotation quorum, escrow idempotency/insufficient-balance,
   pagination clamping, TTL-on-write-only.

---

## 4. Test & coverage posture

| Area                                  | Count / gate                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Gateway unit                          | 135 tests, 12 suites; coverage thresholds 70% (statements/lines)                                                                                                                                                                                                                                                                                             |
| Gateway e2e                           | 35 tests (self-contained; mocks DB/Redis; covers 402 flow, replay, debt-gate, streaming, W3C trace propagation)                                                                                                                                                                                                                                              |
| x402-core                             | 66 tests incl. **deterministic property-based** suites (seeded PRNG, 500 iters/property)                                                                                                                                                                                                                                                                     |
| validation                            | 25 tests (new target — was untested)                                                                                                                                                                                                                                                                                                                         |
| notifications                         | 8 tests (new target — idempotent delivery, stable eventId + signed body across retries)                                                                                                                                                                                                                                                                      |
| SDK / config / wallet / dashboard-lib | 15 / existing / existing / existing, all green                                                                                                                                                                                                                                                                                                               |
| Contracts                             | 29 / 46 / 36 tests under `cargo test` — hand-written edge cases PLUS **deterministic property-based suites** (`src/property.rs` per contract: payment-verifier replay-set semantics, credit-escrow deposit→charge→refund→withdraw accounting walk, multisig pagination-window + quorum-ordering + rotation invariants; seeded PRNG, no external fuzz runner) |

Measurable targets vs. maturity bar: e2e thresholds were ratcheted again
(56% stmts / 25% branches / 37% funcs / 53% lines) and unit thresholds hold
at 70%. Contract property/fuzz suites (previously an open gap — see the old
THREAT-MODEL §6 and GAS-OPTIMIZATION §6 items) are now **implemented and
CI-gated**; the remaining **next ratchet** is raising e2e thresholds further
as scenarios are added — tracked in `GAS-OPTIMIZATION.md` §6 and
`MAINNET_READINESS.md` §1.

---

## 5. Security tooling (automated)

| Tool                      | Where             | Gate                                 |
| ------------------------- | ----------------- | ------------------------------------ |
| `pnpm audit`              | CI `security`     | fail on **critical**; high+ reported |
| gitleaks                  | CI `gitleaks`     | fail on any secret in history        |
| trivy (fs, HIGH/CRITICAL) | CI `trivy`        | report + SARIF to Security tab       |
| osv-scanner (npm + cargo) | CI `osv-scanner`  | report                               |
| SBOM (CycloneDX)          | deploy.yml `sbom` | release asset                        |
| pnpm `allowBuilds`        | workspace config  | install-script allowlist             |
| grep-based secret scan    | this audit        | ✅ clean                             |

---

## 6. Operational readiness

- **Health**: `/health` + `/health/live` (liveness), `/health/ready`
  (Postgres + Redis, 503 detail) — Docker `HEALTHCHECK` wired.
- **Metrics + alerts**: `/metrics` (Prometheus), alert rules A1–A7
  (verification-failure spikes, upstream/circuit failures, on-chain record
  failures, 5xx, latency, readiness) in `OBSERVABILITY.md`.
- **RTO/RPO**: Postgres 15 min RPO / 60 min RTO; Redis AOF; contracts are
  on-chain (RPO 0); full DR runbooks in `OPERATIONS.md`.
- **Fail-closed verification**: Horizon errors → 5xx, never false acceptance.

## 7. Verdict

The codebase was already genuinely well-engineered (triple-layer replay
protection, real SSRF guards, tested contracts, honest docs). This pass
closed the concrete gaps a production-grade review finds: a **broken
installer**, an **open payment-window integrity hole**, **no network timeouts**,
**no readiness/metrics surfaces**, **76 (incl. 34 high) dependency
advisories**, **no secret/container/SBOM scanning**, and **root-running
containers**. All tests, typecheck, lint, and the dependency gate are green
in this session; the remaining items are honest, tracked residuals —
**external contract audit** (mainnet gate), **major-version dependency
tracks**, and **executed gas benchmarks** (methodology + ledger provided;
execution requires the Rust toolchain / CI).

---

## 8. Addendum — 2026-09-12 hardening pass

Second full source review. The repo was green at the start (182 unit tests)
but had the following **genuine** defects, all now fixed and regression-tested.

| #   | Defect                                                                                                                                                                                            | Fix                                                                                                                                 | Test                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| H1  | `TRUST_PROXY` defaulted to `1`, so a directly-exposed gateway honoured forged `X-Forwarded-For` and IP rate limiting was bypassable                                                               | Proxy trust is now **disabled unless explicitly set**; production logs a prominent warning when unset                               | `config` parse/load suite (5 cases)                        |
| H2  | Paid rate tier was keyed by client IP only                                                                                                                                                        | Paid tier keyed by the **server-verified payer wallet** from the confirmed payment row; headers never used for the key              | `rate-limit.guard` (9 cases incl. IP rotation)             |
| H3  | Streaming receipts were emitted **after** the upstream `[DONE]`, so clients that stop at `[DONE]` never saw them; the SDK also `return`ed at `[DONE]`                                             | Proxy withholds `[DONE]` and re-emits it after the receipt; SDK drains past `[DONE]` and exposes the final receipt via lazy getters | proxy stream ordering test + SDK receipt test              |
| H4  | SQL time-series buckets were dropped whenever wall-clock time was unaligned to the interval (the normal case)                                                                                     | Window start snapped to the interval grid on both sides                                                                             | analytics unaligned-`now` + sub-hour tests                 |
| H5  | Every escrow draw reused a synthetic `txHash` of `''`, colliding with the unique `Payment.txHash` index → escrow settlement only worked once, and the `escrow:` charge branch never ran           | Unique `escrow:<quoteId>` synthetic hash per draw                                                                                   | new `x402.service` suite (4 cases)                         |
| H6  | Payout automation paid providers without validating the destination or re-checking approval, and recorded the destination as an approver; threshold-1 auto-approve passed an empty signer address | `StrKey` validation, active/approval re-check at proposal time, real signer address recorded, signer derived from the signing key   | new `payouts.service` suite (11 cases)                     |
| H7  | An unexpected numeric Redis reply was misread as `open:1`, fast-failing every request (this was failing the e2e suite)                                                                            | Only a well-formed `open:<n>` reply may reject; anything else fails open like the Redis-error path                                  | circuit-breaker Redis test                                 |
| H8  | In-app notifications lived only in an in-memory queue (the `Notification` table was unused)                                                                                                       | Persisted in Postgres with `read`/`readAt`, exposed via `/api/v1/notifications` + dashboard feed                                    | notifications service suite (11 cases) + dashboard api lib |
| H9  | Gateway e2e suite was **red** (payment forwarding returned 502)                                                                                                                                   | Root-caused to H7; suite is green                                                                                                   | 39/39 e2e                                                  |
| H10 | Dashboard had `jest.config.ts` + 3 spec files but **no `test` target**, so 23 tests never ran in CI (the closed #32 issue was unverifiable)                                                       | Added the `test` target (and the missing `jest-environment-jsdom` dev dependency the config already required)                       | 23 dashboard tests now run in `nx test --all`              |
| H11 | Once the dashboard suite actually ran, `cn()` was a naive `join(' ')` that never performed the Tailwind conflict resolution its test (and its `clsx`/`tailwind-merge` deps) expected              | Implemented `cn` as `twMerge(clsx(inputs))`                                                                                         | `utils.spec` conflict-resolution case now passes           |

**Verified at this pass:** unit **423 tests / 27 suites across 8 projects**
(gateway 214, x402-core 67, config 36, wallet 30, validation 25, dashboard 23,
sdk 20, notifications 8), e2e **39 tests / 2 suites**, lint **0 errors** (15
pre-existing warnings), `tsc` + `next build` green, `pnpm audit` **0 critical**.
**Not verifiable in this environment:** Rust `cargo test`/benches (no Rust
toolchain installed) — CI runs them. Independent contract audit and the
dev-tooling advisories remain open tracked residuals.

_Addendum generated 2026-09-12._

_Original report generated 2026-09-08 by automated audit + hardening pass._

---

## 9. Addendum — 2026-09-12 repository-structure & deployment-manifest pass

Third review. The codebase was already green (lint, typecheck, 423 unit tests,
49 e2e tests, gateway bundle), so this pass focused on **repository structure**
and the **Kubernetes deployment manifests**, where genuine defects remained.

### 9.1 Dead / duplicated trees removed (32 files)

Three Python SDK implementations and three Kubernetes manifest sets had
accumulated. Only one of each was referenced by any doc, CI job, or script —
the rest were unmaintained duplicates that would confuse contributors and
drift out of sync. Verified with a whole-repo reference scan before removal.

| #   | Removed                                                                       | Why                                                                                                                                                                                                                                             |
| --- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | `github-4-Pay-Per-Token-LLM-Gateway-pay-per-token-llm-gateway.py` (repo root) | An unrelated **FastAPI** `/health` + `/ready` snippet — no relation to this NestJS gateway; an agent-sweep artifact (referenced only by `NEX_AGENT_DELIVERABLE.md`)                                                                             |
| S2  | `packages/python-sdk/`                                                        | Abandoned Poetry prototype (`from x402 import ChatX402`), unreferenced; superseded by `python/`                                                                                                                                                 |
| S3  | `packages/x402-sdk-python/`                                                   | Abandoned setuptools prototype (`from x402 import x402Client`), unreferenced; shipped the **same `x402` import name** as S2 — a real packaging collision if either were ever published                                                          |
| S4  | `k8s/gateway.yaml`                                                            | Stray single manifest, unreferenced; its liveness probe hit the **non-existent** `/api/v1/health` (health is deliberately outside the api prefix)                                                                                               |
| S5  | `infrastructure/k8s/` (flat manifests + `base/` kustomize set)                | Unreferenced duplicate of `infrastructure/kubernetes/`; contained a broken migration initContainer (`node dist/main.js --migrate-only` — the entry point is `dist/apps/gateway/main.js` and no such flag exists) and `/health` readiness probes |

**Kept:** `python/` (canonical Python SDK — hatchling packaging, full offline
test suite, LangChain integration) and `infrastructure/kubernetes/` (the only
manifest set with a README, a migrations Job, and image names matching
`deploy.yml`). Neither removed tree appeared in `pnpm-lock.yaml` or the Nx
graph, so the frozen-lockfile install is unaffected.

> `NEX_AGENT_DELIVERABLE.md` pointed only at the removed S1 file and was itself
> removed in the follow-up pass (§9.5).

### 9.2 Kubernetes manifest defects fixed (`infrastructure/kubernetes/`)

| #   | Defect                                                                                                                                                                                                                                         | Fix                                                                                                                                                                                                             |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Gateway **readinessProbe hit `/health`** — a static liveness answer — so a pod with a dead PostgreSQL or Redis stayed `Ready` and received paid traffic it could not serve                                                                     | Readiness now hits **`/health/ready`** (the only endpoint that probes the dependencies). Liveness deliberately stays on `/health` so a transient dependency outage drains the pod instead of restart-looping it |
| D2  | ConfigMap set no **`PUBLIC_GATEWAY_URL`**, so 402 quotes/instructions fell back to `http://0.0.0.0:3000` — a URL no client can reach                                                                                                           | Added `PUBLIC_GATEWAY_URL: https://gateway.example.com` (kept in sync with `ingress.yaml`)                                                                                                                      |
| D3  | ConfigMap set **`NEXT_PUBLIC_GATEWAY_URL: http://gateway:3000`** — doubly wrong: `NEXT_PUBLIC_*` is inlined by Next.js at **build** time (a runtime ConfigMap is a no-op), and the in-cluster `gateway` DNS name is unreachable from a browser | Replaced with a comment explaining it must be baked at image build time using the **public** ingress URL                                                                                                        |
| D4  | Gateway and dashboard Deployments declared **no `securityContext`** and automounted the default ServiceAccount token                                                                                                                           | Added `runAsNonRoot: true`, `seccompProfile: RuntimeDefault`, `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, and `automountServiceAccountToken: false` to both                                  |

All `infrastructure/kubernetes/*.yaml` files re-parse cleanly (PyYAML
`safe_load_all`).

### 9.3 Documentation drift corrected

| #    | Drift                                                                                                                                       | Fix                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Doc1 | `README.md` described `contracts/deployed-addresses.json` as **gitignored** — it is tracked and committed back by the `deploy.yml` workflow | Corrected to state it is committed and refreshed on each `v*` tag                     |
| Doc2 | `README.md` roadmap marked the **Python SDK** and **Kubernetes manifests** as unfinished (`[ ]`) while both exist and are tested            | Marked complete, with their canonical paths (`python/`, `infrastructure/kubernetes/`) |
| Doc3 | `AUDIT.md` §8 rows **H8 and H9 were merged onto one line**, breaking the markdown table                                                     | Split into two rows                                                                   |

**Investigated and dismissed:** `.env.example` appeared to begin with a stray
`[TEMPLATE]` line, but that was a file-read annotation, not file content — no
change was made.

### 9.4 Verification evidence (this pass)

| Check                                               | Result                                       |
| --------------------------------------------------- | -------------------------------------------- |
| `nx run-many --target=lint --all` (15 projects)     | ✅ 0 errors (15 pre-existing warnings)       |
| `nx run-many --target=test --all` (8 projects)      | ✅ **423 tests / 27 suites**                 |
| `nx run gateway:test:e2e` (3 suites)                | ✅ **49 tests**                              |
| `nx build gateway` (`tsc` + esbuild bundle)         | ✅ green                                     |
| `git ls-files` reference scan for the removed trees | ✅ zero references outside the removed files |
| `pnpm-lock.yaml` / Nx project graph                 | ✅ no references to the removed packages     |
| `infrastructure/kubernetes/*.yaml` YAML parse       | ✅ all valid                                 |

**Not verifiable in this environment:** live `kubectl kustomize`/cluster apply
(no cluster), and Rust `cargo test` (no toolchain) — unchanged and still
CI-gated. The externally-required items from §1–§8 are unaffected: the
**independent Soroban contract audit** remains the mainnet gate.

### 9.5 Follow-up implementations (same pass)

The three items left open at the end of §9.1–§9.2 were implemented, followed by a
second round (§9.6) that surfaced a Docker base-image defect.

| #   | Item                                                                                          | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | The dashboard's `NEXT_PUBLIC_GATEWAY_URL` was only _documented_ as needing a build-time value | Wired as a real **Docker build arg**: `Dockerfile.dashboard` declares `ARG`/`ENV` before `nx build dashboard`; `docker-compose.yml` forwards it (default `http://localhost:3000`); `deploy.yml` passes the `NEXT_PUBLIC_GATEWAY_URL` repository variable on `v*` tags; `nx.json` adds `{ "env": "NEXT_PUBLIC_GATEWAY_URL" }` to the `@nx/next:build` inputs so the Nx cache busts when it changes; documented in `DEPLOYMENT.md` and the k8s README                                           |
| F2  | The surviving k8s set had **no NetworkPolicy or dedicated ServiceAccount**                    | Added `networkpolicy.yaml` (7 policies) — default-deny ingress + egress, DNS egress for all pods, gateway → Postgres/Redis/HTTPS, dashboard → gateway, migration Job → Postgres, Postgres reachable only by the gateway + migration Job, Redis only by the gateway — and `serviceaccount.yaml` (dedicated `x402-gateway` / `x402-dashboard` accounts, both `automountServiceAccountToken: false`). Wired into `kustomization.yaml`; both Deployments and the migration Job now reference them |
| F3  | `NEX_AGENT_DELIVERABLE.md` was left dangling, pointing at the removed S1 file                 | Removed. `GRANT_SUBMISSION.md` was reviewed and kept — it is internally consistent (its `.github/WAVE8_ISSUES.md` reference exists).                                                                                                                                                                                                                                                                                                                                                          |

**Verified:** the dashboard build arg is inlined into the client bundle (probe
URL found in the app chunks and `routes-manifest.json`); `docker compose config`
resolves the forwarded build arg; lint, the 423 unit tests, and the gateway +
dashboard builds remain green. Manifest and Docker verification is in §9.6.

### 9.6 Readiness gating, manifest CI, and a Docker base-image defect

| #   | Item                                                                                                                                                                                         | Implementation                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F4  | The HTTP tier had no PodDisruptionBudget, and the `maxUnavailable: 0` rollout wasn't soak-gated                                                                                              | Added `poddisruptionbudget.yaml` (`minAvailable: 1` for gateway + dashboard; deliberately **none** for the single-replica Postgres/Redis StatefulSets, where a PDB would only block node drains) plus `minReadySeconds: 10`, `progressDeadlineSeconds: 600`, and `revisionHistoryLimit: 3` on both Deployments                                                                                             |
| F5  | Kubernetes manifests were never validated in CI                                                                                                                                              | New `kubernetes` CI job: `kubectl kustomize` render → `kubeconform` (pinned v0.8.0 binary, SHA-256-verified against the release `CHECKSUMS`) schema validation → `scripts/validate-kubernetes.py`, which asserts `/health/ready` readiness gating, PDB coverage, resolvable `serviceAccountName`s, and NetworkPolicy presence                                                                              |
| F6  | The dashboard build arg could silently regress (ARG/ENV moved below the build step → fallback URL shipped)                                                                                   | New `dashboard-build-arg` CI job builds the dashboard **builder stage** with a probe `NEXT_PUBLIC_GATEWAY_URL` and asserts the value appears in the built bundle                                                                                                                                                                                                                                           |
| F7  | **Defect found by F6: both Docker images were unbuildable.** `docker build` died at `pnpm install --frozen-lockfile` with `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` | The Dockerfiles used `node:20-alpine` + `corepack prepare pnpm@11` (→ pnpm 11.24, which imports `node:sqlite` and needs Node ≥ 22.13). CI had already been fixed for this (Node 22 runners, pinned pnpm 11.24.0); the Dockerfiles were missed. Both fixed to `node:22-alpine` with `pnpm@11.24.0` pinned — this had silently broken `docker compose build` and the tag-triggered `deploy.yml` image builds |

**Verified:** `kubectl kustomize infrastructure/kubernetes` renders **24
resources** (2 Deployments, 2 StatefulSets, 7 NetworkPolicies, 2
PodDisruptionBudgets, 2 ServiceAccounts, Job, Ingress, ConfigMap, Secret,
Namespace, 4 Services); `scripts/validate-kubernetes.py` passes on the render
and **exits 1** on tampered input (readiness path changed, PDBs removed); both
Docker **builder stages build** end-to-end on `node:22-alpine`, with the probe
URL inlined into 20 bundle files; `kubeconform -strict` reports **24/24 valid**
against the render. The only step that stays cluster-only is a live
`kubectl apply` / node drain, which needs a real cluster.

### 9.7 Container runtime smoke test — a second Docker defect

§9.6 proved the _builder_ stage. This pass built and booted the **full gateway
image** against real Postgres + Redis — and it crash-looped at startup:

> `PrismaClientInitializationError: Unable to require(...libquery_engine-linux-musl.so.node)`
> — `Error loading shared library libssl.so.1.1: No such file or directory`

Prisma selects which libssl variant of its query engine to download by probing
the build host for the `openssl` **CLI**. Alpine's node image ships `libssl.so.3`
but not the CLI, so detection failed and the generator silently produced the
**OpenSSL 1.1** engine. Installing `openssl` in the builder alone then produced a
second mismatch — the builder generated `linux-musl-openssl-3.0.x` while the
runtime, still CLI-less, detected the generic `linux-musl` and could not find it.

**F8 — Fix:** install `openssl` in **both** stages of `Dockerfile.gateway`
(builder, before `prisma generate`; and runtime). The image now ships
`libquery_engine-linux-musl-openssl-3.0.x.so.node` and boots. Like F7 this was
masked by the Node/pnpm failure — the image could never get far enough to hit it.

**Smoke-test evidence** — full image, real Postgres 16 + Redis 7, `NODE_ENV=production`:

| Check                                                      | Result                                                                                                          |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| container user                                             | `uid=1000(node)` — non-root, as designed                                                                        |
| `GET /health/live`                                         | 200                                                                                                             |
| `GET /health/ready`                                        | 200 · `database: ok (86 ms)` · `redis: ok`                                                                      |
| `GET /metrics`                                             | 200                                                                                                             |
| `GET /api/docs`                                            | 200 (Swagger)                                                                                                   |
| `POST /api/v1/chat/completions` (route configured, unpaid) | **402** with a well-formed quote (amount `1000000`, USDC + Circle testnet issuer, memo, `issuedAt`/`expiresAt`) |
| quote `statusUrl`                                          | used `PUBLIC_GATEWAY_URL` — independently validates the §9.2 configmap fix                                      |
| `POST` for an unknown model                                | **404** `No route configured for model: …`                                                                      |
| `x402_quotes_generated_total`                              | incremented to 1                                                                                                |
| security headers                                           | CSP, `X-Frame-Options: SAMEORIGIN`, `X-Content-Type-Options: nosniff`                                           |

Also verified incidentally: `prisma migrate deploy` applies every migration to a
fresh database — the path the k8s migration Job and the backup/restore drill use.

### 9.8 CI guard for the gateway image

Both Docker defects (F7, F8) were invisible without actually building _and_
running the image, so a new **`gateway-image`** CI job does exactly that on every
PR: build both stages, boot the container against Postgres + Redis service
containers, assert `/health/live` and `/health/ready` return 200 (readiness runs
`SELECT 1` through Prisma — the precise failure mode of F8), and assert the
process is non-root. The job's runner sequence was executed verbatim during this
pass and passes: readiness `database: ok (64 ms)`, `redis: ok`, `uid=1000`.

CI now has **16 jobs**. The three added across §9.6–§9.8 (`kubernetes`,
`dashboard-build-arg`, `gateway-image`) turn the manifest and container
regressions found in this pass into permanent, self-checking gates.

### 9.9 Deploy-path defect: the k8s migration Job could not run

With the image finally bootable, the next thing to verify was the schema path the
cluster uses. `infrastructure/kubernetes/migrations-job.yaml` overrides the
gateway image's command with `npx --no-install prisma migrate deploy --schema
packages/database/prisma/schema.prisma`. Running that verbatim against the real
image:

> `npm error npx canceled due to missing packages and no YES option: ["prisma@8.0.0-rc.14"]`

**F9 — cause:** the Prisma CLI is not at `/app/node_modules/.bin/prisma` — pnpm's
isolated layout puts binaries in each package's own `.bin`
(`/app/packages/database/node_modules/.bin/prisma`) — so `npx --no-install` found
no local CLI and tried to **download Prisma 8** from the registry. In a cluster
with no egress the Job fails outright; on a node that can reach the registry it
would run the _wrong_ Prisma version against the production schema.

**Fix:** set `workingDir: /app/packages/database` on the Job container and use
the package-relative schema. Verified on a fresh database: **0 → 11 tables**.
The `gateway-image` CI job now applies migrations with this exact command before
booting the gateway, so the deploy path is exercised on every PR — previously it
was never executed anywhere.

### 9.10 CI triage: the Vercel deploy failure on `main`

While the commit was waiting to be pushed, the one pre-existing red workflow was
triaged. `Deploy Dashboard to Vercel` fails on every push to `main` (including
the baseline `2d852ba`, so it predates this pass) after 13 s:

> `##[error]Input required and not supplied: vercel-token`

**F10 — cause:** `amondnet/vercel-action` requires a non-empty `vercel-token`,
and `VERCEL_TOKEN` / `VERCEL_ORG_ID` / `VERCEL_PROJECT_ID` were never configured
on the repository. That is a configuration gap rather than a build defect, but it
left every push to `main` permanently red — and this pass's commit, which deletes
files under `packages/**` (a path in that workflow's `paths` filter), would have
added one more.

**Fix:** the job now bridges the credential check through job env
(`HAS_VERCEL_SECRET: ${{ secrets.VERCEL_TOKEN != '' }}`) and skips the deploy with
a warning annotation plus a setup table in the job summary — the same pattern
`deploy.yml`'s `deploy_contracts` job already uses for `HAS_STELLAR_SECRET`.

That bridge is required, not stylistic: `secrets` is not an allowed context in a
step-level `if:`. actionlint confirms this directly — available contexts there
are `env`, `github`, `inputs`, `job`, `matrix`, `needs`, `runner`, `steps`,
`strategy`, `vars`.

The `paths` filter was deliberately left unchanged: the dashboard does import
workspace packages, so `packages/**` belongs there.

**Evidence:** actionlint v1.7.12 reports clean across all three workflows, and was
proven non-vacuous by feeding it a control file containing the
`secrets`-in-a-step-`if` anti-pattern, which it flagged. The new step's shell was
extracted and executed standalone: it emits the warning annotation and renders the
setup table into `$GITHUB_STEP_SUMMARY`.

**Not changed there (flagged only):** `deploy.yml`'s `docker` job has the same
latent trap with `DOCKER_USERNAME` / `DOCKER_PASSWORD`, but it is tag-gated rather
than push-triggered, so it is not producing noise today.

### 9.11 The same guard applied to the release path (`deploy.yml`)

The `docker` job logs into Docker Hub with `DOCKER_USERNAME` / `DOCKER_PASSWORD`.
Those credentials are unset, and the shape of the failure is identical to F10:
`docker/login-action` fails with an opaque authentication error instead of
stating that the secrets are missing.

This one was **latent rather than noisy**: the `Deploy` workflow has never run at
all — the repository has no tags (`git tag -l` is empty), so this release path has
executed zero times. That is itself worth noting, since everything in `deploy.yml`
is untested.

**Fix:** the job bridges the same presence check through job env
(`HAS_DOCKER_CREDENTIALS`), skips the push, and reports it — following the
convention already set inside this same file by
`deploy_contracts` / `HAS_STELLAR_SECRET`.

**Deliberate difference from §9.10:** skipping the Vercel deploy is harmless (it
runs on every push to `main` and simply does not publish a preview). Skipping
_this_ job means a release produced **no images at all**, so the notice states that
explicitly and the warning annotation includes the tag via `$GITHUB_REF_NAME`. It
must not be mistaken for a normal green release.

**Evidence:** actionlint clean; the step's shell extracted and executed with
`GITHUB_REF_NAME=v1.2.3` — it emits the tag-scoped warning and renders the setup
table. `.nvmrc` is `22`, so unlike the Dockerfiles there is no Node/pnpm mismatch
on this path.

**Also tidied (F11):** the `docker` job carried a `Read Node version from .nvmrc`
step whose output was never consumed anywhere. It is dead by construction — both
images are built inside their own Dockerfiles (`FROM node:22-alpine`), so the
runner's Node version cannot affect them. The only `steps.nvm.outputs.NODE_VERSION`
consumer in the file is the `sbom` job, which has its own copy of the step. Removed,
with a comment recording why no Node setup belongs in this job so it is not
re-added.
