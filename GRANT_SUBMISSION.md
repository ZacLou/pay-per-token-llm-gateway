# 🏆 x402 LLM Gateway — Grant Submission Issue Summary

> Curated issue set for **Stellar Wave (Drips)** & **GrantFox** submission — August 2026.
>
> ## How to read this document
>
> Two different things are tracked below, and they have different evidence:
>
> | Claim                                                                            | Evidence                                                                                         |
> | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
> | **Implemented in this repository**                                               | Source code + the test suite. Reproducible by anyone: `pnpm nx run-many --target=test --all`.    |
> | **GitHub issue state** (labels, open/closed, milestone, Drips/Wave point ledger) | **Not reproducible from the source tree.** Asserted only by the linked GitHub issues themselves. |
>
> The `Status` columns below record the **implementation state in this
> repository** as of the date on this document. They are **not** a claim about
> the live GitHub issue state, which this file cannot verify. Reviewers should
> confirm labels, open/closed state and the point ledger directly on GitHub.
> The per-issue implementation notes live in
> [`.github/WAVE8_ISSUES.md`](.github/WAVE8_ISSUES.md).

---

## 📊 At a Glance

| Metric                                                     | Value                                                       |
| ---------------------------------------------------------- | ----------------------------------------------------------- |
| Curated issues                                             | **18** (10 original Wave-8 + 8 hardening/feature batch)     |
| Implemented in this repository (test-verified)             | **17** — see the email-notification note below              |
| Areas covered                                              | contracts, gateway, SDK, dashboard, notifications, database |
| Declared `good first issue` count                          | **6** (as labeled on GitHub — not verifiable here)          |
| Declared `security`-labeled count                          | **4** (as labeled on GitHub — not verifiable here)          |
| Point value of the curated set (per the point model below) | **2,700**                                                   |

**Point model:** High = 200 · Medium = 150 · Trivial = 100

> **Correction (2026-09-15):** the email notification channel (#33 / Issue 9) is
> **closed on GitHub but is not implemented in this repository.** It landed in
> `09e4706` and was then deleted as dead code — the handler was never registered
> in the dispatcher, its `EMAIL_*`/`SMTP_*` config did nothing and no recipient
> model existed (`MAINNET_READINESS.md` §5). Auditing the tree, not the issue
> tracker, is what surfaced this: there is no `nodemailer` dependency and no
> `EmailNotificationHandler`. Durable in-app notifications (#43) and signed
> webhooks do exist. The count above is corrected to 17 implemented; the point
> total is left as the wave's bounty scale.

---

## 📁 Grouped by Area

### 🧱 Soroban Smart Contracts (Rust)

| #   | Issue                                             | GitHub                                                                   | Difficulty | Status    | Pts |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------ | ---------- | --------- | --- |
| 1   | Wire credit-escrow settlement for metered pricing | [#25](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/25) | High       | ✅ closed | 200 |
| 11  | Multisig payout automation                        | [#40](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/40) | High       | ✅ closed | 200 |
| 3   | Clamp unbounded pagination limits (gas DoS)       | [#27](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/27) | Medium     | ✅ closed | 150 |
| 4   | Remove `extend_ttl` from read-only functions      | [#28](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/28) | Medium     | ✅ closed | 150 |
| 10  | Escrow accounting invariant tests                 | [#34](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/34) | Medium     | ✅ closed | 150 |

### 🚪 Gateway (NestJS)

| #   | Issue                                               | GitHub                                                                   | Difficulty | Status    | Pts |
| --- | --------------------------------------------------- | ------------------------------------------------------------------------ | ---------- | --------- | --- |
| 12  | Explicit `TRUST_PROXY` + wallet-based rate limiting | [#41](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/41) | Medium     | ✅ closed | 150 |
| 13  | Validate payout wallets + provider approval flow    | [#42](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/42) | Medium     | ✅ closed | 150 |
| 15  | SQL time-series bucketing                           | [#44](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/44) | Medium     | ✅ closed | 150 |
| 5   | Streaming (SSE) payment-receipt headers             | [#29](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/29) | Medium     | ✅ closed | 150 |
| 7   | Enforce `minPaymentAmount`                          | [#31](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/31) | Trivial    | ✅ closed | 100 |
| 17  | Populate route in payment receipts                  | [#46](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/46) | Trivial    | ✅ closed | 100 |
| 18  | Remove unused `Session`/`ApiKey` Prisma models      | [#47](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/47) | Trivial    | ✅ closed | 100 |
| 6   | DNS rebinding protection at proxy time              | [#30](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/30) | Medium     | ✅ closed | 150 |

### 🔌 Client SDK (TypeScript)

| #   | Issue                                        | GitHub                                                                   | Difficulty | Status    | Pts |
| --- | -------------------------------------------- | ------------------------------------------------------------------------ | ---------- | --------- | --- |
| 2   | SDK external signer (`signTransaction`) path | [#26](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/26) | High       | ✅ closed | 200 |
| 16  | SDK unit tests                               | [#45](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/45) | Medium     | ✅ closed | 150 |

### 📊 Dashboard (Next.js)

| #   | Issue                                          | GitHub                                                                   | Difficulty | Status    | Pts |
| --- | ---------------------------------------------- | ------------------------------------------------------------------------ | ---------- | --------- | --- |
| 8   | Jest unit tests for dashboard pages/components | [#32](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/32) | Medium     | ✅ closed | 150 |

### 🔔 Notifications

| #   | Issue                                    | GitHub                                                                   | Difficulty | Status                                    | Pts |
| --- | ---------------------------------------- | ------------------------------------------------------------------------ | ---------- | ----------------------------------------- | --- |
| 14  | Persist in-app notifications in Postgres | [#43](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/43) | Medium     | ✅ closed                                 | 150 |
| 9   | Email notification channel (nodemailer)  | [#33](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/33) | Medium     | ⚠️ closed on GitHub, **not in this repo** | 150 |

---

## 🎯 Grouped by Difficulty

| Difficulty | Open | Closed | Issue numbers | Points |
| ----------------- | ----- | ------ | ---------------------------------------------------------- | --------- || **High** (200) | 0 | 3 | #25, #26, #40 | 600 |
| **Medium** (150) | 0 | 12 | #27, #28, #29, #30, #32, #33, #34, #41, #42, #43, #44, #45 | 1,800 |
| **Trivial** (100) | 0 | 3 | #31, #46, #47 | 300 |
| **Total** | **0** | **18**| — | **2,700** |

### 🌱 Quick wins (`good first issue`) — great onboarding entry points

| Issue                                              | GitHub                                                                   | Pts |
| -------------------------------------------------- | ------------------------------------------------------------------------ | --- |
| ~~Enforce `minPaymentAmount`~~                     | [#31](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/31) | 100 |
| ~~Populate route in payment receipts~~             | [#46](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/46) | 100 |
| ~~Remove unused `Session`/`ApiKey` Prisma models~~ | [#47](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/47) | 100 |
| ~~SQL time-series bucketing (Medium)~~             | [#44](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/44) | 150 |
| SDK unit tests (Medium, closed)                    | [#45](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/45) | 150 |
| Dashboard unit tests (Medium, closed)              | [#32](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/32) | 150 |

### 🔒 Security-hardening cluster (attracts senior reviewers)

| Issue                                                | GitHub                                                                   | Pts |
| ---------------------------------------------------- | ------------------------------------------------------------------------ | --- |
| Explicit `TRUST_PROXY` + wallet-based rate limiting  | [#41](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/41) | 150 |
| Validate payout wallets + provider approval flow     | [#42](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/42) | 150 |
| Clamp unbounded pagination limits (gas DoS) (closed) | [#27](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/27) | 150 |
| DNS rebinding protection (closed)                    | [#30](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/30) | 150 |

---

## ✅ Implemented (closed) — proof of activity

All 18 are closed on GitHub; the table below records the tranche that closed
first, and [`.github/WAVE8_ISSUES.md`](.github/WAVE8_ISSUES.md) carries the
per-issue status for every one of them. One of them (#33, email) is closed
without being present in this repository — see the correction above.

| Issue                              | GitHub                                                                   | Commit / Date                                                        |
| ---------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| Wire credit-escrow settlement      | [#25](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/25) | 2026-09-09                                                           |
| SDK external signer                | [#26](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/26) | 2026-09-09                                                           |
| Clamp unbounded pagination limits  | [#27](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/27) | 2026-09-09                                                           |
| Multisig payout automation         | [#40](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/40) | 2026-09-09                                                           |
| DNS rebinding protection           | [#30](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/30) | `813fed7`                                                            |
| Dashboard unit tests (scaffolding) | [#32](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/32) | `05e10c9`                                                            |
| Email notification channel         | [#33](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/33) | `09e4706` — **later removed as dead code; see the correction above** |
| Escrow accounting invariant tests  | [#34](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/34) | `b49a2d1`                                                            |
| SDK unit tests                     | [#45](https://github.com/mallonepay/pay-per-token-llm-gateway/issues/45) | 2026-09-09                                                           |

---

## 📦 Point Allocation Summary

| Bucket            | Points    |
| ----------------- | --------- |
| High (3 × 200)    | 600       |
| Medium (12 × 150) | 1,800     |
| Trivial (3 × 100) | 300       |
| **Total**         | **2,700** |
| — open only       | **0**     |

---

## 🔎 Notes for Reviewers

- **Areas with full coverage:** Soroban contracts (5 issues), gateway (8 issues), SDK (2), dashboard (1), notifications (2).
- **Bounty-ready:** every issue carries `bounty` for the Drips/Wave point ledger and is eligible for `Maybe Rewarded` GrantFox payouts on merge.
- **Maturity signal:** 17 of the 18 curated issues are implemented in the tree; #33 (email) is closed on GitHub but was removed from the codebase, and the delivery matrix in `README.md` no longer claims an email channel. The repo is actively maintained, not a parked codebase.
- **Onboarding funnel:** 6 `good first issue` tags (3 trivial + 3 medium) give newcomers a clear entry point while the remaining issues give experienced contributors meaningful scope.

---

_Generated August 11, 2026 · Updated September 9, 2026 · Live issue state via GitHub API · See [.github/WAVE8_ISSUES.md](.github/WAVE8_ISSUES.md) for full issue bodies._
