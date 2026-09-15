#!/usr/bin/env bash
#
# Live Stellar Testnet credit-escrow settlement leg — reproducible evidence.
#
# Boots the stack locally (Postgres + Redis in Docker, the gateway on port
# 3200) with escrow settlement ENABLED, then runs scripts/testnet-escrow.ts
# against the LIVE Stellar Testnet:
#
#   deploy a fresh credit-escrow → user deposits USDC → per-token request
#   through the real gateway → metered charge + unused-surplus refund verified
#   on-chain (revenue up, escrow drawn, tokens returned).
#
# The upstream "LLM" is a public HTTPS echo that returns the posted JSON
# verbatim, so the caller supplies an OpenAI-shaped `usage.total_tokens` and the
# gateway meters it exactly as it would a real provider's. That keeps the
# metered charge/refund deterministic and the evidence reproducible, and it
# satisfies the proxy's SSRF guard (public IP) without weakening it.
#
# Evidence is appended to docs/evidence/testnet-journey.json under `escrow`.
#
# Requirements: docker (running), node, pnpm, the `stellar` CLI, and network
# access to Stellar Testnet (Horizon + friendbot + Soroban RPC) and the
# upstream echo.
#
# Usage: bash scripts/testnet-escrow.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR=".testnet-journey"
mkdir -p "$STATE_DIR" docs/evidence

PG_PORT="${PG_PORT:-55432}"
REDIS_PORT="${REDIS_PORT:-56379}"
GATEWAY_PORT="${GATEWAY_PORT:-3200}"
PG_NAME="x402-escrow-pg"
REDIS_NAME="x402-escrow-redis"
PG_DB="x402"
PG_USER="x402"
PG_PASS="x402-escrow-local"

GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

# ── 1. Postgres ─────────────────────────────────────────────
log "Starting Postgres (${PG_NAME}) on port ${PG_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  echo "  (reusing running container)"
elif docker ps -a --format '{{.Names}}' | grep -qx "$PG_NAME"; then
  docker start "$PG_NAME" >/dev/null
  echo "  (restarted existing container)"
else
  docker run -d --name "$PG_NAME" \
    -e POSTGRES_DB="$PG_DB" -e POSTGRES_USER="$PG_USER" -e POSTGRES_PASSWORD="$PG_PASS" \
    -p "127.0.0.1:${PG_PORT}:5432" \
    postgres:16-alpine >/dev/null
fi
for i in $(seq 1 30); do
  docker exec "$PG_NAME" pg_isready -U "$PG_USER" -d "$PG_DB" >/dev/null 2>&1 && break
  sleep 1
done
echo "  postgres ready"

# ── 2. Redis ────────────────────────────────────────────────
log "Starting Redis (${REDIS_NAME}) on port ${REDIS_PORT}"
if docker ps --format '{{.Names}}' | grep -qx "$REDIS_NAME"; then
  echo "  (reusing running container)"
elif docker ps -a --format '{{.Names}}' | grep -qx "$REDIS_NAME"; then
  docker start "$REDIS_NAME" >/dev/null
  echo "  (restarted existing container)"
else
  docker run -d --name "$REDIS_NAME" -p "127.0.0.1:${REDIS_PORT}:6379" redis:7-alpine >/dev/null
fi
for i in $(seq 1 30); do
  redis-cli -p "$REDIS_PORT" ping >/dev/null 2>&1 && break
  sleep 1
done
echo "  redis ready"

# ── 3. Migrations + Prisma client ───────────────────────────
log "Applying database migrations"
pnpm nx run database:generate >/dev/null 2>&1 || true
(cd packages/database && DATABASE_URL="$DATABASE_URL" pnpm exec prisma migrate deploy)
echo "  migrations applied"

# ── 4. Secrets (persisted so reruns reuse the funded accounts) ──
mksecret() { (cd packages/wallet && node -e "const {Keypair}=require('@stellar/stellar-sdk'); process.stdout.write(Keypair.random().secret())"); }

ISSER_STATE="$STATE_DIR/issuer.env"
if [ -f "$ISSER_STATE" ]; then
  # shellcheck disable=SC1090
  . "$ISSER_STATE"
  echo "  (reusing issuer)"
else
  ISSUER_SECRET="$(mksecret)"
  echo "ISSUER_SECRET=$ISSUER_SECRET" > "$ISSER_STATE"
  echo "  (generated fresh issuer)"
fi
export ISSUER_SECRET

ADMIN_STATE="$STATE_DIR/escrow-admin.env"
if [ -f "$ADMIN_STATE" ]; then
  # shellcheck disable=SC1090
  . "$ADMIN_STATE"
  echo "  (reusing escrow admin)"
else
  ESCROW_ADMIN_SECRET="$(mksecret)"
  echo "ESCROW_ADMIN_SECRET=$ESCROW_ADMIN_SECRET" > "$ADMIN_STATE"
  echo "  (generated fresh escrow admin)"
fi
export ESCROW_ADMIN_SECRET

USER_STATE="$STATE_DIR/escrow-user.env"
if [ -f "$USER_STATE" ]; then
  # shellcheck disable=SC1090
  . "$USER_STATE"
  echo "  (reusing escrow user)"
else
  ESCROW_USER_SECRET="$(mksecret)"
  echo "ESCROW_USER_SECRET=$ESCROW_USER_SECRET" > "$USER_STATE"
  echo "  (generated fresh escrow user)"
fi
export ESCROW_USER_SECRET

# ── 5. Build the gateway ─────────────────────────────────────
log "Building gateway"
pnpm nx build gateway

# ── 6. Deploy phase — fresh escrow + user deposit (no gateway needed) ──
log "Deploying credit-escrow and funding the user's escrow"
ESCROW_MODE=deploy \
ESCROW_WASM="$ROOT/contracts/credit-escrow/target/wasm32-unknown-unknown/release/credit_escrow.wasm" \
STATE_FILE="$STATE_DIR/escrow-state.json" \
ESCROW_STATE_FILE="$STATE_DIR/escrow-state.json" \
ISSUER_SECRET="$ISSUER_SECRET" \
ESCROW_ADMIN_SECRET="$ESCROW_ADMIN_SECRET" \
ESCROW_USER_SECRET="$ESCROW_USER_SECRET" \
DATABASE_URL="$DATABASE_URL" \
TS_NODE_TRANSPILE_ONLY=1 \
NODE_PATH="packages/wallet/node_modules:packages/database/node_modules:apps/gateway/node_modules:node_modules" \
  npx ts-node --project apps/gateway/tsconfig.json scripts/testnet-escrow.ts

ESCROW_CONTRACT_ID="$(jq -r .escrowId "$STATE_DIR/escrow-state.json")"
echo "  fresh credit-escrow: $ESCROW_CONTRACT_ID"

# ── 7. Start the gateway with escrow settlement enabled ──────
if [ -f "$STATE_DIR/escrow-gateway.pid" ] && kill -0 "$(cat "$STATE_DIR/escrow-gateway.pid")" 2>/dev/null; then
  log "Stopping previous escrow gateway"
  kill "$(cat "$STATE_DIR/escrow-gateway.pid")" 2>/dev/null || true
  sleep 1
  rm -f "$STATE_DIR/escrow-gateway.pid"
fi
log "Flushing escrow Redis"
docker exec "$REDIS_NAME" redis-cli flushall >/dev/null 2>&1 || true

log "Starting gateway on port ${GATEWAY_PORT} (escrow settlement enabled)"
JWT_SECRET="$(openssl rand -hex 32)"
cat > "$STATE_DIR/escrow-gateway.env" <<EOF
NODE_ENV=development
HOST=127.0.0.1
PORT=$GATEWAY_PORT
PUBLIC_GATEWAY_URL=$GATEWAY_URL
DATABASE_URL=$DATABASE_URL
REDIS_URL=redis://127.0.0.1:$REDIS_PORT
JWT_SECRET=$JWT_SECRET
STELLAR_NETWORK=testnet
USDC_ISSUER=$(cd packages/wallet && ISSUER_SECRET="$ISSUER_SECRET" node -e "const {Keypair}=require('@stellar/stellar-sdk'); process.stdout.write(Keypair.fromSecret(process.env.ISSUER_SECRET).publicKey())")
WEBHOOK_ENABLED=false
ESCROW_SETTLEMENT_ENABLED=true
CREDIT_ESCROW_CONTRACT=$ESCROW_CONTRACT_ID
CONTRACT_ADMIN_SECRET=$ESCROW_ADMIN_SECRET
EOF
# shellcheck disable=SC1091
set -a; . "$STATE_DIR/escrow-gateway.env"; set +a

NODE_PATH=packages/database/node_modules:node_modules \
  nohup node dist/apps/gateway/main.js > "$STATE_DIR/escrow-gateway.log" 2>&1 &
echo $! > "$STATE_DIR/escrow-gateway.pid"
for i in $(seq 1 60); do
  if curl -sf "$GATEWAY_URL/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "$GATEWAY_URL/health" >/dev/null || {
  echo "gateway failed to start — see $STATE_DIR/escrow-gateway.log" >&2
  tail -30 "$STATE_DIR/escrow-gateway.log" >&2
  exit 1
}
echo "  gateway healthy"

# ── 8. Settlement phase — per-token request, charge + refund on-chain ──
log "Running live escrow settlement leg"
set +e
ESCROW_MODE=run \
GATEWAY_URL="$GATEWAY_URL" \
ISSUER_SECRET="$ISSUER_SECRET" \
ESCROW_ADMIN_SECRET="$ESCROW_ADMIN_SECRET" \
ESCROW_USER_SECRET="$ESCROW_USER_SECRET" \
ESCROW_STATE_FILE="$STATE_DIR/escrow-state.json" \
DATABASE_URL="$DATABASE_URL" \
EVIDENCE_PATH="docs/evidence/testnet-journey.json" \
TS_NODE_TRANSPILE_ONLY=1 \
NODE_PATH="packages/wallet/node_modules:packages/database/node_modules:apps/gateway/node_modules:node_modules" \
  npx ts-node --project apps/gateway/tsconfig.json scripts/testnet-escrow.ts
ESCROW_EXIT=$?
set -e

if [ $ESCROW_EXIT -ne 0 ]; then
  echo -e "\033[1;31mESCROW LEG FAILED (exit $ESCROW_EXIT)\033[0m" >&2
  echo "--- gateway log tail ---" >&2
  tail -40 "$STATE_DIR/escrow-gateway.log" >&2
  exit $ESCROW_EXIT
fi

echo -e "\033[1;32m═══════════════════════════════════════════════════════════════"
echo "  LIVE ESCROW SETTLEMENT LEG: ALL CHECKS PASSED"
echo "  Evidence: docs/evidence/testnet-journey.json (escrow)"
echo "═══════════════════════════════════════════════════════════════\033[0m"
