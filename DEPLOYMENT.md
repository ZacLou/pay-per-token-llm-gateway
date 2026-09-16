# x402 LLM Gateway — Deployment Guide

This guide covers deploying the two components of the x402 LLM Gateway:

| Component               | Platform | Type       | Why                                                           |
| ----------------------- | -------- | ---------- | ------------------------------------------------------------- |
| **Gateway** (NestJS)    | Railway  | Container  | Long-running server with WebSockets, needs PostgreSQL + Redis |
| **Dashboard** (Next.js) | Vercel   | Serverless | Next.js is natively supported with zero config                |

---

## Prerequisites

- GitHub repository with the code pushed
- A Stellar testnet account with secret key (generate one with the Stellar CLI: `stellar keys generate --global my-account --network testnet`, then fund it from the [Stellar testnet faucet](https://laboratory.stellar.org/#account-creator?network=test))
- Upstream LLM API key (e.g., OpenAI API key)

---

## Part 1: Deploy Gateway to Railway

### 1.1 Create Railway Account

Go to [railway.app](https://railway.app) and sign up with GitHub.

### 1.2 Add PostgreSQL and Redis

1. Click **New Project** → **Deploy from GitHub repo**
2. Select your x402-llm-gateway repository
3. Click **+ New** → **Database** → **Add PostgreSQL**
4. Click **+ New** → **Database** → **Add Redis**

> **Monorepo import:** Railway detects pnpm workspaces and stages one service per
> deployable package, configured for Railpack (`pnpm --filter … build`). Those
> services **cannot build the gateway** — it needs the repository-root build
> context and the container image. Delete the auto-staged services, add a single
> service from this repository, and configure it as in §1.3.

### 1.3 Configure the Gateway Service

1. Select the gateway service from your repo
2. Under **Settings** → **Environment**, add:

| Variable                            | Value                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| `NODE_ENV`                          | `production`                                                                         |
| `STELLAR_NETWORK`                   | `testnet`                                                                            |
| `DATABASE_URL`                      | `${{Postgres.DATABASE_URL}}` (Railway reference)                                     |
| `REDIS_URL`                         | `${{Redis.REDIS_URL}}` (Railway reference)                                           |
| `JWT_SECRET`                        | (Generate: `openssl rand -base64 32`)                                                |
| `PUBLIC_GATEWAY_URL`                | `https://your-gateway.up.railway.app` — the **public** URL                           |
| `TRUST_PROXY`                       | `1` (Railway terminates TLS one hop away)                                            |
| `USDC_ISSUER`                       | `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5`                           |
| `CORS_ORIGINS`                      | `https://your-dashboard.vercel.app`                                                  |
| `UPSTREAM_API_KEY_YOUR_PROVIDER_ID` | `sk-your-openai-api-key`                                                             |
| `PORT`                              | `3000`                                                                               |
| `HORIZON_TIMEOUT_MS`                | `10000` (optional, per-request Horizon timeout)                                      |
| `SOROBAN_RPC_TIMEOUT_MS`            | `10000` (optional, per-request Soroban RPC timeout)                                  |
| `RUN_MIGRATIONS_ON_START`           | `true` (optional) — set `false` only if migrations are applied outside the container |

3. Under **Settings** → **Source**, set:
   - **Root Directory**: `/` — the repository root. The Dockerfile copies the
     pnpm workspace (`pnpm-lock.yaml`, `packages/`, `scripts/`) from the root, so
     the build context must be the repository root and not `apps/gateway`.

4. Under **Settings** → **Build**, set:
   - **Dockerfile path**: `infrastructure/docker/Dockerfile.gateway`

5. Under **Settings** → **Deploy**, set:
   - **Health Check Path**: `/health/ready`

   Prefer the readiness endpoint over `/health`. Railway checks this path before
   promoting the deployment, so a gateway that cannot reach Postgres or Redis
   **fails the deploy** with that reason, instead of going live and answering 503
   to every request. `/health` only proves the process started — if you would
   rather the deployment succeed and surface dependency failures at request
   time, use `/health` and rely on §1.5 step 1 for the check.

> **These are service settings, not file-driven.** There is no `railway.json` in
> this repository. Railway has retired Config as Code: new services **cannot opt
> in**, and existing files stop being read on **2026-12-01**. The settings above —
> with the environment table — are therefore the whole configuration, and the
> Root Directory and Dockerfile path are not optional. For file-managed
> configuration, Railway's replacement is Infrastructure as Code
> (`.railway/railway.ts`, applied with `railway config plan` / `railway config
apply`); a service cannot be managed by both systems at once.

### 1.4 Deploy

Click **Deploy**. The gateway will:

1. Build the Docker image
2. Connect to PostgreSQL and Redis
3. **Apply pending Prisma migrations** — the image entrypoint runs
   `prisma migrate deploy` before starting the server
   (`infrastructure/docker/docker-entrypoint.sh`), so a fresh deploy can never
   come up against an empty schema
4. Start on port 3000

If the migrations fail, the container **exits** rather than serving traffic
against a partial schema — read the Prisma error in the deploy logs. To manage
migrations yourself instead (e.g. from CI), set
`RUN_MIGRATIONS_ON_START=false` and run `pnpm db:migrate:deploy` against the
production `DATABASE_URL`. Railway can also run them as a pre-deploy step
(`deploy.preDeployCommand`); if you use that, set
`RUN_MIGRATIONS_ON_START=false` so they are not attempted twice. The gateway
still refuses to start against an empty or partially migrated schema either way
(`apps/gateway/src/common/schema-guard.ts`).

The guard distinguishes an **empty** schema from a `prisma db push`-managed one:
outside production a database that has every core table but no
`_prisma_migrations` history logs a warning and starts, which is what keeps the
local Quick Start (`prisma db push`) working. In production that same state is a
hard failure, because the entrypoint migrates on every boot — missing history
there means migrations were bypassed and the schema will drift from the
migration history later deploys are applied against.

Note the gateway URL (e.g., `https://x402-gateway.up.railway.app`).

### 1.5 Verify the gateway BEFORE deploying the dashboard

**Do this first.** Deploying the dashboard against an unreachable gateway
produces a dashboard that renders `Connecting...` and `...` indefinitely, with
no obvious cause — exactly how the live outage presented. Proving the gateway
works first makes any later problem unambiguously a dashboard problem. Setting
`NEXT_PUBLIC_GATEWAY_URL` in Vercel **cannot** rescue an unreachable gateway.

```bash
GW=https://your-gateway.up.railway.app

# 1. Readiness — both dependencies must report "ok".
#    A 503 names the dependency that failed.
curl -s "$GW/health/ready"

# 2. The unpaid flow must return 402 with a usable status URL.
#    Needs a configured route — see the note below the snippet.
curl -s -X POST "$GW/api/v1/chat/completions" \
  -H 'Content-Type: application/json' \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"hi"}]}'
```

Read the 402 body: `statusUrl` must be the **public** URL you set in
`PUBLIC_GATEWAY_URL`. If it shows `http://0.0.0.0:3000/...`, the variable is not
set and every paying client receives a status link they cannot poll.

> **Step 2 requires a route, and none exists until Part 3.** On a freshly
> deployed gateway it answers
> `404 {"message":"No route configured for model: gpt-4"}`. That is the expected
> pre-Part-3 response, not a deploy failure — step 1 already proved the
> deployment is healthy. Re-run step 2 after creating the route in Part 3, using
> the same `model`; the pass condition is a `402` whose `statusUrl` is your
> public URL.

Optionally, prove the whole wiring locally before spending time on hosting —
this boots Postgres, Redis and the gateway and asserts the dashboard's own API
client receives real data:

```bash
pnpm e2e:dashboard
```

#### Troubleshooting

| Symptom                                                           | Cause                                                                                           | Fix                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Container exits; log says `Database schema is not migrated`       | Migrations failed, or were disabled                                                             | Leave `RUN_MIGRATIONS_ON_START` at its default (`true`), or run `pnpm db:migrate:deploy` against the production DB                |
| `/health/ready` returns **503** with `database` failed            | `DATABASE_URL` doesn't reference the Postgres service                                           | Set it to `${{Postgres.DATABASE_URL}}`                                                                                            |
| 402 body has `statusUrl: http://0.0.0.0:3000/...`                 | `PUBLIC_GATEWAY_URL` unset                                                                      | Set it to the public gateway URL                                                                                                  |
| Proxy answers **404** `No route configured for model: X`          | No route is registered for that `model`, or the request's `model` doesn't match the route's     | Create a provider and a route with that `model` (Part 3). Before Part 3 this is the expected response, not a failure              |
| Dashboard stuck on `Connecting...` / metrics stuck at `...`       | `NEXT_PUBLIC_GATEWAY_URL` missing from the Vercel build, or the gateway isn't browser-reachable | Verify the gateway above, set the variable in Vercel, then **redeploy** — it is inlined at build time, so a redeploy is mandatory |
| Browser console reports a CORS error                              | The dashboard's origin isn't in the gateway's allow-list                                        | Add it to `CORS_ORIGINS` (comma-separated), e.g. `https://your-dashboard.vercel.app`                                              |
| `NEXT_PUBLIC_GATEWAY_URL` set in Vercel but the site is unchanged | The value is baked in at build time; an existing deployment keeps the old bundle                | Trigger a new deployment                                                                                                          |
| Signed in, then logged out on the next page load                  | The session cookie is third-party (gateway host set from the dashboard's origin)                | Set `NEXT_PUBLIC_GATEWAY_SAME_ORIGIN=true` so the cookie is first-party, then redeploy                                            |

---

## Part 2: Deploy Dashboard to Vercel

### 2.1 Create Vercel Account

Go to [vercel.com](https://vercel.com) and sign up with GitHub.

### 2.2 Import the Project

1. Click **Add New** → **Project**
2. Select your x402-llm-gateway repository
3. Configure:

| Setting            | Value            |
| ------------------ | ---------------- |
| **Framework**      | Next.js          |
| **Root Directory** | `apps/dashboard` |

Leave **Build Command** and **Output Directory** empty — they're provided by
`apps/dashboard/vercel.json` (`pnpm exec next build` outputs `.next` inside
`apps/dashboard`, which is exactly where Vercel looks for it).

> ⚠️ Keep the build command as `next build` — not `nx build dashboard`.
> Vercel runs the command from the Root Directory (`apps/dashboard`), and the
> Nx `@nx/next:build` executor fails there with
> `ENOENT: scandir 'apps/dashboard/public'` on a cold cache.

### 2.3 Set Environment Variables

| Variable                          | Value                                 |
| --------------------------------- | ------------------------------------- |
| `NEXT_PUBLIC_GATEWAY_URL`         | `https://your-gateway.up.railway.app` |
| `NEXT_PUBLIC_GATEWAY_SAME_ORIGIN` | `true`                                |

> **Set `NEXT_PUBLIC_GATEWAY_SAME_ORIGIN=true`** (recommended). The dashboard
> then calls `/api/v1/*` on its **own** origin and the rewrite in
> `apps/dashboard/next.config.js` proxies that to the gateway. The session cookie
> the gateway sets is therefore bound to the dashboard's host — a **first-party**
> cookie. Without it the browser calls the gateway's origin directly
> (`*.up.railway.app` from a `*.vercel.app` page) and the cookie is third-party,
> which Safari's ITP and Chrome's third-party-cookie limits may drop, in which
> case sign-in does not stick. In same-origin mode the gateway's `CORS_ORIGINS`
> is no longer load-bearing for the dashboard (the request is server-to-server),
> though it is still needed for any other browser client.

> ⚠️ This value is baked into the client bundle at **build time**, so set it in
> the Vercel project → **Settings → Environment Variables** **before** the first
> build. If the gateway isn't deployed yet, use its future URL — the dashboard
> builds fine without it, but API calls will fail until it points at a live
> gateway.

### 2.4 Deploy

Click **Deploy**. Vercel will install the monorepo dependencies (via
`pnpm install --frozen-lockfile`), build the dashboard with `next build`, and
serve the `.next` output.

---

## Part 3: Initialize the Gateway

Once both services are deployed, initialize the gateway:

### 3.1 Create a Provider

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/providers \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "name": "My LLM Provider",
    "walletAddress": "YOUR_STELLAR_WALLET_ADDRESS",
    "payoutWalletAddress": "YOUR_PAYOUT_WALLET_ADDRESS"
  }'
```

### 3.2 Create a Route

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/routes \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -d '{
    "providerId": "PROVIDER_ID_FROM_ABOVE",
    "path": "/v1/chat/completions",
    "upstreamUrl": "https://api.openai.com/v1/chat/completions",
    "model": "gpt-4",
    "pricingModel": "flat",
    "flatPrice": "1000000",
    "acceptedAssets": ["USDC"],
    "rateLimit": 10
  }'
```

---

## Part 4: Test the x402 Payment Flow

### 4.1 Send Request Without Payment (Expect 402)

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

**Expected Response (402):**

```json
{
  "status": 402,
  "message": "Payment Required",
  "quote": {
    "id": "...",
    "amount": "1000000",
    "asset": "USDC",
    "paymentAddress": "GA5ZSE...",
    "network": "testnet"
  }
}
```

### 4.2 Pay on Stellar Testnet

Using the Stellar CLI or any Stellar wallet, send the quoted amount to the payment address:

```bash
stellar tx new --source alice --network testnet \
  --op payment --destination YOUR_GATEWAY_ADDRESS \
  --asset USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5 \
  --amount 0.1
```

### 4.3 Retry Request with Payment Hash

```bash
curl -X POST https://your-gateway.up.railway.app/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Payment-Hash: YOUR_TRANSACTION_HASH" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
```

### 4.4 Expected Success Response

The gateway verifies the payment on-chain and proxies to the LLM:

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "choices": [...],
  "usage": {...}
}
```

---

## Part 5: Mainnet Deployment

> ⚠️ **Mainnet moves real USDC.** Everything below assumes you have real
> funds, real accounts, and production-grade secrets. Test the full flow on
> testnet first (Parts 1–4).

### 5.1 Prerequisites

- The `stellar` CLI (v20+) and `jq` — for contract deployment
- A funded Stellar mainnet account (its secret key becomes the contract admin)
- Real mainnet USDC (the gateway uses Circle's official USDC issuer:
  `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`)
- Strong secrets: `openssl rand -base64 32` for `JWT_SECRET`,
  `POSTGRES_PASSWORD`, and `REDIS_PASSWORD`

### 5.2 Deploy contracts to mainnet

The gateway reads its contract IDs from environment variables, so the
contracts must be deployed and initialized on mainnet before the gateway
starts. `scripts/deploy-contracts.sh` handles the build, the deploy, and the
initialization — the constructor arguments are passed to
`stellar contract deploy`, so deploy + init are a **single transaction** and
there is no `init` gap for anyone to race — then persists the new IDs to
`contracts/deployed-addresses.json`:

```bash
STELLAR_NETWORK=mainnet \
STELLAR_SECRET_KEY=S... \
USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
MULTISIG_SIGNERS=G... \
bash scripts/deploy-contracts.sh
```

Notes:

- The script defaults the Soroban RPC and network passphrase per network
  (mainnet → `https://soroban-mainnet.stellar.org` /
  `Public Global Stellar Network ; September 2015`), and only needs
  `STELLAR_SECRET_KEY` + `USDC_ISSUER` overridden.
- **You must pass the mainnet `USDC_ISSUER` explicitly** — the script's
  default is the testnet issuer.
- The deploying account's public key becomes the admin of
  `payment-verifier` and `credit-escrow`, and the default multisig signer.
- After deployment, copy the mainnet IDs from
  `contracts/deployed-addresses.json` into your environment
  (`PAYMENT_VERIFIER_CONTRACT`, `CREDIT_ESCROW_CONTRACT`,
  `MULTISIG_CONTRACT`).

### 5.3 Docker Compose (mainnet)

A hardened compose file is included:

```bash
docker compose -f infrastructure/docker/docker-compose.mainnet.yml up -d
docker compose -f infrastructure/docker/docker-compose.mainnet.yml ps
```

Both commands read their values from the environment, and Compose loads `.env`
from the **compose file's** directory (`infrastructure/docker/`) — never the
repository root. Copy `.env.mainnet.example` to `infrastructure/docker/.env`, or
pass `--env-file` pointing at wherever you keep it. Without the values this file
fails fast and starts nothing at all, Postgres included.

Unlike the dev file, it **fails fast when secrets are missing**:

| Variable                                                                     | Required | Purpose                                           |
| ---------------------------------------------------------------------------- | -------- | ------------------------------------------------- |
| `POSTGRES_PASSWORD`                                                          | ✅       | Postgres password (fail-fast)                     |
| `REDIS_PASSWORD`                                                             | ✅       | Redis password (fail-fast)                        |
| `JWT_SECRET`                                                                 | ✅       | Session signing (fail-fast)                       |
| `CONTRACT_ADMIN_SECRET`                                                      | ✅       | On-chain payment recording (fail-fast)            |
| `PAYMENT_VERIFIER_CONTRACT` / `CREDIT_ESCROW_CONTRACT` / `MULTISIG_CONTRACT` | ✅       | Mainnet contract IDs (fail-fast)                  |
| `USDC_ISSUER`                                                                | –        | Defaults to Circle mainnet issuer                 |
| `CORS_ORIGINS`                                                               | –        | Defaults to the Vercel dashboard                  |
| `TRUST_PROXY`                                                                | –        | Set to your real proxy chain for IP rate limiting |

It pins `STELLAR_NETWORK=mainnet`, adds `restart: unless-stopped`, and
healthchecks every service. A full reference lives in `.env.mainnet.example`.

#### Dashboard URL in Docker builds

The dashboard reads `NEXT_PUBLIC_GATEWAY_URL` at **build** time — Next.js
inlines `NEXT_PUBLIC_*` into the client bundle, so setting it at container
start has no effect. Supply it when building the image instead:

```bash
NEXT_PUBLIC_GATEWAY_URL=https://gateway.example.com \
  docker compose --env-file .env -f infrastructure/docker/docker-compose.yml build dashboard
```

`--env-file .env` is required: Compose looks for `.env` next to the compose file
(`infrastructure/docker/`), not the repository root, so without it the required
`JWT_SECRET` in `docker-compose.yml` is unset and Compose aborts before building
anything (`pnpm docker:build` passes the flag for you). Naming the service
explicitly is enough — a profile-gated service still builds when it is targeted.

`docker compose` forwards it as the `Dockerfile.dashboard` build arg, and the
`deploy.yml` workflow passes the GitHub repository variable of the same name on
`v*` tags. The value must be the **public** gateway URL a browser can reach —
never an in-cluster Service DNS name such as `http://gateway:3000`. The mainnet
compose file (`docker-compose.mainnet.yml`) requires it and fails fast when it
is unset, so a mainnet dashboard can never ship with a localhost URL baked in.

### 5.4 Railway deployment

Create a Railway project with PostgreSQL and Redis (same layout as Part 1),
then set the gateway service variables:

| Variable                                                                     | Mainnet value                                                                                     |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                   | `production`                                                                                      |
| `STELLAR_NETWORK`                                                            | `mainnet`                                                                                         |
| `USDC_ISSUER`                                                                | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN`                                        |
| `HORIZON_URL`                                                                | `https://horizon.stellar.org`                                                                     |
| `SOROBAN_RPC_URL`                                                            | `https://soroban-mainnet.stellar.org`                                                             |
| `DATABASE_URL`                                                               | Railway Postgres URL                                                                              |
| `REDIS_URL`                                                                  | Railway Redis URL                                                                                 |
| `JWT_SECRET`                                                                 | random 256-bit value                                                                              |
| `CONTRACT_ADMIN_SECRET`                                                      | mainnet admin secret key                                                                          |
| `PAYMENT_VERIFIER_CONTRACT` / `CREDIT_ESCROW_CONTRACT` / `MULTISIG_CONTRACT` | deployed mainnet IDs                                                                              |
| `TRUST_PROXY`                                                                | `1` when behind your proxy chain (Railway/Cloudflare); leave unset for a directly-exposed gateway |

### 5.5 Security considerations

- **Real assets at stake**: start with small limits, verify a single real
  payment end-to-end, and monitor `X-Payment-Receipt` headers before
  scaling.
- **Secret management**: never put `CONTRACT_ADMIN_SECRET` or `JWT_SECRET`
  in git. Use Railway's encrypted variables, a secret manager, or a
  hardware-backed signer.
- **Rate limiting**: unpaid requests are limited per IP and confirmed
  payments are limited per verified payer wallet. `TRUST_PROXY` is disabled
  by default (forwarding headers ignored) — set it explicitly only when the
  gateway is behind a trusted proxy, or forged `X-Forwarded-For` would widen
  the IP tier.
- **Contract admin**: keep the admin account's signing key offline when
  possible; use the multisig contract for higher-value operations.
- **Audit trail**: on-chain payment records are permanent. Test refunds on
  a low-value account first.

### 5.6 Pre-launch checklist

- [ ] `cargo test` passes for all three contracts (see `contracts/`)
- [ ] Mainnet contracts deployed and initialized; IDs in env
- [ ] `STELLAR_NETWORK=mainnet` and mainnet `USDC_ISSUER` confirmed in the
      running config (`GET /health` or admin config view)
- [ ] Real USDC payment completes and receipt shows the real route
- [ ] `docker compose -f infrastructure/docker/docker-compose.mainnet.yml ps` shows all services `healthy`
- [ ] Secrets rotated, `.env.mainnet.example` never committed with values
- [ ] `pnpm smoke:production` passes — it reads the gateway URL out of the
      **live dashboard bundle** (not the Vercel env var) and checks that URL
      answers as a gateway, which is how a `localhost` bundle or a dead gateway
      is caught
- [ ] The gateway service's **watch paths** cover everything the gateway
      bundles, not just `apps/gateway/**`. Railway's default trigger for this
      service watched only `/apps/gateway/**`, so a change under
      `packages/config` (the config the gateway loads at boot) was marked
      `SKIPPED` instead of deployed — the image would silently keep running the
      old code. Keep `/apps/gateway/**`, `/packages/**`, `/pnpm-lock.yaml` and
      `/tsconfig.base.json`

---

## Part 6: Testnet verification journey & operations

### 6.1 Verifying the complete user journey on Stellar Testnet

Run this exact sequence against a testnet deployment (this is what the
automated e2e suite — `apps/gateway/src/e2e/x402-flow.e2e-spec.ts` — mocks;
the steps below exercise the live chain):

```bash
# 1. Liveness + readiness (dependencies up)
curl -s https://gateway/health && curl -s https://gateway/health/ready | jq .checks

# 2. Metrics endpoint is scrapeable
curl -s https://gateway/metrics | grep -E "x402_(quotes|payments)"

# 3. Unpaid request → 402 with a quote (capture quote.amount / quote.id)
curl -s -X POST https://gateway/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'

# 4. Pay the quoted amount from a funded testnet wallet to quote.paymentAddress
#    (USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5), then:
curl -s -X POST https://gateway/api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "X-Payment-Hash: <tx_hash>" \
  -d '{"model":"gpt-4","messages":[{"role":"user","content":"Hello"}]}'
# → 200 with LLM response + X-Payment-Receipt header

# 5. Replay the SAME hash → expect 402 "This payment has already been used"

# 6. SDK smoke test (auto 402 → pay → retry)
node -e "
const { X402Client } = require('@x402/sdk');
const c = new X402Client({ gatewayUrl: 'https://gateway', secretKey: process.env.SK, network: 'testnet' });
c.call({ model: 'gpt-4', messages: [{ role: 'user', content: 'hi' }] }).then(r => console.log(r.success ? 'OK ' + r.response.id : 'FAIL ' + r.error));
"
```

Negative checks to include in the rehearsal: wrong-issuer payment → 402;
payment older than the quote (reused historical hash) → 402 _before quote
issued_; amount below deposit (per-token route) → 402 "below the quoted
deposit"; expired quote → 402.

### 6.1.1 Live verification run — 2026-09-08 ✅

Executed against Stellar Testnet with a freshly friendbot-funded account
(stellar CLI 28.0.0, soroban-sdk 22, Rust 1.98.1). All three contracts were
**deployed fresh, initialized, and exercised live**; the artifacts are still
on testnet:

> **Historical note.** This run predates the 2026-09-14 change that moved
> initialization into a Soroban `__constructor` and removed the `init` entry
> point from all three contracts. Rows below that read `init(admin)` or
> "Deploy + init …" record the two-transaction flow **as it was at the time**;
> those steps now happen inside `stellar contract deploy`. The contract IDs and
> WASM sizes below belong to the superseded build.

| Step                           | Result          | Evidence                                                                                                                 |
| ------------------------------ | --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Fund fresh account (friendbot) | ✅              | `GCZZNR5U5FVSSYIBAGMV7S6G46FSKSX3QF4I2SG7ADV6U6SNCGSYU5SJ`                                                               |
| Build WASM (release, opt)      | ✅              | `payment_verifier.wasm` 6,814 B                                                                                          |
| Deploy payment-verifier        | ✅              | `CADOAAAF6HCEVA4AL35HMMGAQQGFE5BROQAE6VUA4TNACGIMCULCP6OF`                                                               |
| `init(admin)`                  | ✅              | tx `2ef8ac2a…`                                                                                                           |
| `record_payment` (live)        | ✅              | tx `3c0a518a…` — `pay_verif` event emitted                                                                               |
| **Replay same tx_hash**        | ✅ **rejected** | VM trap `UnreachableCodeReached` (contract panicked "already recorded") — replay protection live                         |
| `is_payment_used`              | ✅ `true`       | read-only invoke                                                                                                         |
| `total_payments`               | ✅ `1`          | replay did not double-count                                                                                              |
| Deploy + init multisig         | ✅              | `CDYA65VZDNJEYSFQHTNS2Y4V67SP7GKW7PTYSWILPISUPH2MZPMDKUWE`                                                               |
| `propose` (payout path)        | ✅              | proposal #0, `proposed` event                                                                                            |
| `approve` → quorum             | ✅              | `approved` event emitted; transfer to unfunded token failed **closed** (`MissingValue`) — fail-closed behavior confirmed |
| Deploy + init credit-escrow    | ✅              | `CDCLIZ45BJUEXOJVJDQVU25VJRIMCF77B7TENHUZAR5JUCRITZQEJ4F3`; `balance` = 0                                                |

**Escrow lifecycle (deposit → charge → refund → revenue withdrawal) — verified
live 2026-09-08** with a self-deployed test token (own SAC admin, so minting
needs no issuer cooperation):

| Leg                                  | Result          | Evidence                                                   |
| ------------------------------------ | --------------- | ---------------------------------------------------------- |
| Deploy test SAC (`TUSDC`, own admin) | ✅              | `CDFD5KD7QRNOQTBEU42YHF42AXC3YSN3X3OMGNM345FFZQB62ZW44RRO` |
| Deploy + init escrow bound to it     | ✅              | `CCOZEFLX7ADDYFNFXR7F4IDGN47XVAYYD3SUUWM6OGZLAJP6VQYNXNO5` |
| Mint 1,000 → user                    | ✅              | user balance = 1,000                                       |
| `deposit` 800 (user-signs transfer)  | ✅              | escrow balance(user) = 800; trustline required first       |
| `charge` 250 (admin)                 | ✅              | balance 800→550; revenue 0→250; `usage` event              |
| **Replay charge (same quote)**       | ✅ **rejected** | VM trap; balance stays 550                                 |
| `refund` 50 (admin)                  | ✅              | escrow balance 550→500; user tokens +50                    |
| **Replay refund (same quote)**       | ✅ **rejected** | VM trap; balance stays 500                                 |
| `withdraw_revenue` 250 → admin       | ✅              | revenue 250→0; escrow tokens 750→500                       |
| **Accounting invariant**             | ✅              | escrow tokens (500) == escrow balance (500) + revenue (0)  |

Note on real USDC: the production USDC asset contract (`CBIELT…`) is
controlled by its own admin, so minting _real_ testnet USDC requires issuer
cooperation — this leg is covered by the e2e suite (mocked token) and unit
benchmarks; the payout transfer leg requires funding the multisig with real
testnet USDC (fail-closed when unfunded was verified live).

### 6.1.2 Live gateway journey run — 2026-09-09 ✅ (full-stack, reproducible)

The **complete user journey through the running gateway** — fund → trustlines
→ mint → unpaid 402 + quote → on-chain payment → 200 + receipt → replay
rejected → forged hash rejected → balance check — was executed live against
Stellar Testnet and passed every assertion. It is fully reproducible:

```bash
bash scripts/testnet-journey.sh
```

The script boots Postgres + Redis (Docker), applies the real migration
history to a fresh database, builds and starts the gateway, funds fresh
accounts via friendbot, and drives the HTTP + on-chain flow. Evidence with
**full (untruncated) transaction hashes** is written to
`docs/evidence/testnet-journey.json` (committed) and printed as a table;
any unexpected HTTP status fails the run.

| Step                                    | Result           | Evidence (full hashes / addresses)                                                                                 |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| Fund fresh accounts (friendbot)         | ✅               | issuer `GBS36HW…V7WQB`, payer `GAHH47…55S4A`, receiver `GAWCBK…3NAIM`                                              |
| Payer trustline (`USDC:journey issuer`) | ✅               | `03200f89e60f2e39f2baff0586ea3d09aa2ba45cf68d5298124de46e85c2926f`                                                 |
| Receiver trustline                      | ✅               | `7e0fab2e08c9770f39a45f059674f7be757d111d8900050945ee577419d4240a`                                                 |
| Mint 100 USDC → payer                   | ✅               | `8cd5ca6f59af641286fce6ebf36a593f3702cf0f2254fcf36107f1de501d95a0`                                                 |
| Unpaid request → HTTP 402 + quote       | ✅ (5/5 asserts) | quote amount `1000000` stroops, asset `USDC`, issuer matches; memo `4a550a82569c4cb883d33b50`                      |
| On-chain payment (repo wallet builder)  | ✅               | `de98320e68074d0a97dd63a016195ea2551ac004aabc52f1cea97f3ffe11c100`, ledger **4585952**, 0.1 USDC → provider wallet |
| Retry with `X-Payment-Hash`             | ✅ (4/4 asserts) | HTTP 200 + `X-Payment-Receipt`; `receipt.txHash` matches, `status: confirmed`                                      |
| **Replay same hash**                    | ✅ **402**       | `"This payment has already been used"` — single-use enforcement live                                               |
| **Forged / never-existing hash**        | ✅ **402**       | `"Payment verification failed: …"` — fail-closed                                                                   |
| Final balances                          | ✅               | receiver holds the paid 0.1 USDC (money visibly moved)                                                             |

This closes the previous evidence gap (the §6.1.1 run exercised the
contracts directly; this run exercises the **gateway HTTP + verification +
single-use path** against the live chain). Horizon links for every step are
in the evidence JSON.

### 6.2 Operations

- Health/readiness semantics, RTO/RPO targets, backup/restore and DR
  runbooks: [`OPERATIONS.md`](./OPERATIONS.md).
- Dashboards and alert rules: [`OBSERVABILITY.md`](./OBSERVABILITY.md)
  (+ `docs/dashboards/x402-gateway.json`).
- Apply Prisma migrations explicitly (`pnpm db:migrate`) — never `db:push`
  against a database with real traffic without reviewing the diff.

## Deployed Contract Addresses (Testnet)

| Contract         | Address                                                    |
| ---------------- | ---------------------------------------------------------- |
| payment-verifier | `CDHGI3A2BXRC5AQDPWEEXUDQMDXTDZYBCLJZWSE5XZKMVEGJ5LLHA4CZ` |
| credit-escrow    | `CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP` |
| multisig         | `CDMBVMMNJVAJVAV3T2TAL2TAACGTKYUS45RXNLCYKYUC3VGHBI66NWAA` |

---

## Architecture

```
┌──────────────────┐     ┌──────────────────┐
│   Vercel         │     │   Railway         │
│   Dashboard      │────▶│   Gateway         │
│   (Next.js)      │     │   (NestJS)        │
└──────────────────┘     └───────┬──────────┘
                                 │
                    ┌────────────┼────────────┐
                    ▼            ▼            ▼
              ┌──────────┐ ┌──────────┐ ┌──────────┐
              │ Postgres │ │  Redis   │ │ Stellar  │
              │ (Railway)│ │ (Railway)│ │ Testnet  │
              └──────────┘ └──────────┘ └──────────┘
```
