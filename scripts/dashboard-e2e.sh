#!/usr/bin/env bash
#
# Dashboard E2E — one command, full stack, real data.
#
# Boots Postgres + Redis + the gateway, then proves the dashboard's own API
# client receives real data from it. Answers the question the deployed Vercel
# dashboard failed: "does the thing the browser runs actually reach the API?"
#
#   1. Postgres + Redis (dedicated containers/ports — never touches your dev stack)
#   2. Apply migrations (`prisma migrate deploy`)
#   3. Build + start the gateway
#   4. Run scripts/dashboard-e2e.ts, which drives apps/dashboard/src/lib/api.ts
#      against the live gateway and asserts every page's data source returns
#      real rows (providers, routes, payments, audit, notifications, analytics,
#      escrow) and that a 402 moves the analytics numbers
#   5. Production-build the dashboard and assert NEXT_PUBLIC_GATEWAY_URL was
#      inlined into the *client* bundle — the exact regression that shipped
#      `localhost:3000` to production while every unit test passed
#
# Evidence: docs/evidence/dashboard-e2e.json
#
# Requirements: docker (running), node, pnpm, and network access only for the
# dashboard's `next build`. No Stellar network access is needed — this checks
# stack wiring, not payments (that is scripts/testnet-journey.sh).
#
# Usage: bash scripts/dashboard-e2e.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR=".dashboard-e2e"
mkdir -p "$STATE_DIR" docs/evidence

PG_PORT="${PG_PORT:-55433}"
REDIS_PORT="${REDIS_PORT:-56380}"
GATEWAY_PORT="${GATEWAY_PORT:-3200}"

PG_NAME="x402-dash-e2e-pg"
REDIS_NAME="x402-dash-e2e-redis"
PG_DB="x402_dashboard_e2e"
PG_USER="x402"
PG_PASS="x402-dashboard-e2e"

GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"
JWT_SECRET="$(openssl rand -hex 32)"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

stop_gateway() {
  if [ -f "$STATE_DIR/gateway.pid" ]; then
    kill "$(cat "$STATE_DIR/gateway.pid")" 2>/dev/null || true
    rm -f "$STATE_DIR/gateway.pid"
  fi
}
trap stop_gateway EXIT

# ── 1. Postgres ─────────────────────────────────────────────
log "Starting Postgres (${PG_NAME}) on port ${PG_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  echo "  (reusing running container)"
elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  docker start "$PG_NAME" >/dev/null && echo "  (restarted existing container)"
else
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_DB="$PG_DB" -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASS" \
    -p "127.0.0.1:${PG_PORT}:5432" postgres:16-alpine >/dev/null
  echo "  (created container)"
fi
for _ in $(seq 1 30); do
  docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null
echo "  postgres ready"

# ── 2. Redis ────────────────────────────────────────────────
log "Starting Redis (${REDIS_NAME}) on port ${REDIS_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "$REDIS_NAME"; then
  echo "  (reusing running container)"
elif docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_NAME"; then
  docker start "$REDIS_NAME" >/dev/null && echo "  (restarted existing container)"
else
  docker run -d --name "$REDIS_NAME" -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
  echo "  (created container)"
fi
# Use docker exec rather than a local redis-cli — the CLI is not installed on
# most dev machines or CI images, and the container always has one.
for _ in $(seq 1 30); do
  docker exec "$REDIS_NAME" redis-cli ping >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$REDIS_NAME" redis-cli ping >/dev/null
echo "  redis ready"

# ── 3. Migrations ───────────────────────────────────────────
log "Applying migrations to a clean database"
docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "DROP DATABASE IF EXISTS ${PG_DB}" >/dev/null 2>&1
docker exec "$PG_NAME" psql -U "$PG_USER" -d postgres -c "CREATE DATABASE ${PG_DB}" >/dev/null
pnpm nx run database:generate >/dev/null 2>&1
(cd packages/database && DATABASE_URL="$DATABASE_URL" pnpm exec prisma migrate deploy >/dev/null)
echo "  migrations applied"

# ── 4. Build + start the gateway ────────────────────────────
log "Building gateway"
pnpm nx build gateway

log "Starting gateway on port ${GATEWAY_PORT}"
stop_gateway
docker exec "$REDIS_NAME" redis-cli flushall >/dev/null 2>&1 || true

# `env -i` gives the gateway a deterministic environment. Without it, ambient
# variables (a developer's shell, a Codespaces .env, CI) leak in — and a stray
# PUBLIC_GATEWAY_URL is exactly what this script exists to catch.
#
# SOROBAN_RPC_URL points at a closed port on purpose: the only route that talks
# to Soroban is `GET /escrow/:address/balance`, which the dashboard leg below
# calls. Failing fast on a refused connection keeps that check deterministic and
# offline — the real testnet endpoint would hang on it for the RPC timeout and
# make the check depend on Stellar network access, which this script promises
# not to need.
env -i \
  PATH="$PATH" \
  HOME="$HOME" \
  NODE_PATH="packages/database/node_modules:node_modules" \
  NODE_ENV=development \
  HOST=127.0.0.1 \
  PORT="$GATEWAY_PORT" \
  PUBLIC_GATEWAY_URL="$GATEWAY_URL" \
  DATABASE_URL="$DATABASE_URL" \
  REDIS_URL="redis://127.0.0.1:${REDIS_PORT}" \
  JWT_SECRET="$JWT_SECRET" \
  STELLAR_NETWORK=testnet \
  SOROBAN_RPC_URL="http://127.0.0.1:1" \
  CORS_ORIGINS="http://localhost:3001" \
  AUTH_DEV_MODE=true \
  TRUST_PROXY=false \
  WEBHOOK_ENABLED=false \
  nohup node dist/apps/gateway/main.js > "$STATE_DIR/gateway.log" 2>&1 &
echo $! > "$STATE_DIR/gateway.pid"

for _ in $(seq 1 60); do
  curl -sf "$GATEWAY_URL/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$GATEWAY_URL/health" >/dev/null || {
  echo "gateway failed to start — see $STATE_DIR/gateway.log" >&2
  tail -30 "$STATE_DIR/gateway.log" >&2
  exit 1
}
echo "  gateway healthy"

# ── 5. Drive the dashboard's own API client ─────────────────
log "Running dashboard data checks"
GATEWAY_URL="$GATEWAY_URL" \
NEXT_PUBLIC_GATEWAY_URL="$GATEWAY_URL" \
DATABASE_URL="$DATABASE_URL" \
EVIDENCE_PATH="docs/evidence/dashboard-e2e.json" \
TS_NODE_TRANSPILE_ONLY=1 \
NODE_PATH="apps/dashboard/node_modules:packages/database/node_modules:node_modules" \
  npx ts-node --project apps/gateway/tsconfig.json scripts/dashboard-e2e.ts

# ── 6. Assert the URL reaches the CLIENT bundle ─────────────
# The dashboard's unit tests inject a fake env object, so they cannot catch a
# broken `process.env.NEXT_PUBLIC_*` read. Only inspecting a real production
# build can. This is the check that would have caught the live outage.
log "Building the dashboard and asserting the gateway URL is inlined"
(
  cd apps/dashboard
  rm -rf .next
  NEXT_PUBLIC_GATEWAY_URL="$GATEWAY_URL" NODE_ENV=production pnpm exec next build >/dev/null
)
if grep -rqF "$GATEWAY_URL" apps/dashboard/.next/static; then
  echo "  ✅ NEXT_PUBLIC_GATEWAY_URL is inlined into the client bundle"
else
  echo "  ❌ NEXT_PUBLIC_GATEWAY_URL is NOT in the built client assets." >&2
  echo "     The deployed dashboard would fall back to localhost:3000 and never load data." >&2
  echo "     Check that lib reads the literal expression process.env.NEXT_PUBLIC_GATEWAY_URL." >&2
  exit 1
fi

echo -e "\033[1;32m═══════════════════════════════════════════════════════════════"
echo "  DASHBOARD E2E: ALL CHECKS PASSED"
echo "  Evidence: docs/evidence/dashboard-e2e.json"
echo -e "═══════════════════════════════════════════════════════════════\033[0m"
