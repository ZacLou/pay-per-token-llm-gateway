#!/usr/bin/env bash
#
# Live failure-injection sweep — one command, full stack, dependencies down.
#
# Boots Postgres + Redis + TWO gateways:
#   :3210  normal (real Soroban RPC)
#   :3211  degraded (SOROBAN_RPC_URL points at a closed port, escrow enabled)
#
# then runs scripts/failure-injection.ts, which stops/starts PostgreSQL and
# Redis and probes every surface through each outage. The degraded gateway is
# how the Soroban-RPC-down case is exercised without touching the network.
#
# The assertions are about *safe failure*, not availability:
#   - an unpaid request must never return 200
#   - a forged/unknown payment hash must never be accepted
#   - an unverifiable escrow draw must be rejected, with a reason
#   - readiness must name the dependency that is down
#
# Evidence: docs/evidence/failure-injection.json
#
# Requirements: docker (running), node, pnpm.
#
# Usage: bash scripts/failure-injection.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

STATE_DIR=".failure-injection"
mkdir -p "$STATE_DIR" docs/evidence

PG_PORT="${PG_PORT:-55434}"
REDIS_PORT="${REDIS_PORT:-56381}"
GATEWAY_PORT="${GATEWAY_PORT:-3210}"
DEGRADED_PORT="${DEGRADED_PORT:-3211}"
PG_NAME="x402-failinject-pg"
REDIS_NAME="x402-failinject-redis"
PG_DB="x402_failure_injection"
PG_USER="x402"
PG_PASS="x402-failure-injection"

GATEWAY_URL="http://127.0.0.1:${GATEWAY_PORT}"
DEGRADED_GATEWAY_URL="http://127.0.0.1:${DEGRADED_PORT}"
DATABASE_URL="postgresql://${PG_USER}:${PG_PASS}@127.0.0.1:${PG_PORT}/${PG_DB}"
JWT_SECRET="$(openssl rand -hex 32)"

log() { echo -e "\n\033[1;36m==> $*\033[0m"; }

stop_gateways() {
  for f in "$STATE_DIR/gateway.pid" "$STATE_DIR/degraded-gateway.pid"; do
    if [ -f "$f" ]; then
      kill "$(cat "$f")" 2>/dev/null || true
      rm -f "$f"
    fi
  done
}
trap stop_gateways EXIT

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

# ── 4. Build ────────────────────────────────────────────────
log "Building gateway"
pnpm nx build gateway

# An escrow contract id is only needed so the degraded gateway considers escrow
# *configured*; the balance read is what must fail when the RPC is unreachable.
ESCROW_CONTRACT="$(jq -r '.testnet.creditEscrow // empty' contracts/deployed-addresses.json 2>/dev/null || true)"
ESCROW_CONTRACT="${ESCROW_CONTRACT:-CCE7AWVXPO57W5KDONOPMHDV4S5UBUBMHNJVSAVPL7AZGMD4WQN6WVAP}"

# ── 5. Gateways ─────────────────────────────────────────────
log "Starting gateway on port ${GATEWAY_PORT} (normal)"
stop_gateways
docker exec "$REDIS_NAME" redis-cli flushall >/dev/null 2>&1 || true

common_env() {
  echo "NODE_ENV=development"
  echo "HOST=127.0.0.1"
  echo "PUBLIC_GATEWAY_URL=$GATEWAY_URL"
  echo "DATABASE_URL=$DATABASE_URL"
  echo "REDIS_URL=redis://127.0.0.1:${REDIS_PORT}"
  echo "JWT_SECRET=$JWT_SECRET"
  echo "STELLAR_NETWORK=testnet"
  echo "WEBHOOK_ENABLED=false"
  echo "TRUST_PROXY=false"
  # The sweep deliberately makes many unpaid probes across four phases. The
  # default limit (10 unpaid requests / 60s / IP) would start returning 429 and
  # mask the dependency behaviour under test — a 429 is still a safe failure,
  # but it is not the failure being measured here. Rate limiting has its own
  # coverage; it is not the subject of this sweep.
  echo "RATE_LIMIT_MAX=100000"
}

{ common_env; echo "PORT=$GATEWAY_PORT"; } > "$STATE_DIR/gateway.env"
{ common_env; echo "PORT=$DEGRADED_PORT"; \
  echo "SOROBAN_RPC_URL=http://127.0.0.1:9"; \
  echo "ESCROW_SETTLEMENT_ENABLED=true"; \
  echo "CREDIT_ESCROW_CONTRACT=$ESCROW_CONTRACT"; \
} > "$STATE_DIR/degraded-gateway.env"

start_gateway() {
  local env_file="$1" pid_file="$2" log_file="$3"
  set -a; . "$env_file"; set +a
  NODE_PATH=packages/database/node_modules:node_modules \
    nohup node dist/apps/gateway/main.js > "$log_file" 2>&1 &
  echo $! > "$pid_file"
}

start_gateway "$STATE_DIR/gateway.env" "$STATE_DIR/gateway.pid" "$STATE_DIR/gateway.log"
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

log "Starting degraded gateway on port ${DEGRADED_PORT} (unreachable Soroban RPC)"
start_gateway "$STATE_DIR/degraded-gateway.env" "$STATE_DIR/degraded-gateway.pid" "$STATE_DIR/degraded-gateway.log"
for _ in $(seq 1 60); do
  curl -sf "$DEGRADED_GATEWAY_URL/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -sf "$DEGRADED_GATEWAY_URL/health" >/dev/null || {
  echo "degraded gateway failed to start — see $STATE_DIR/degraded-gateway.log" >&2
  tail -30 "$STATE_DIR/degraded-gateway.log" >&2
  exit 1
}
echo "  degraded gateway healthy"

# ── 6. Sweep ────────────────────────────────────────────────
log "Running the failure-injection sweep"
set +e
GATEWAY_URL="$GATEWAY_URL" \
DEGRADED_GATEWAY_URL="$DEGRADED_GATEWAY_URL" \
PG_NAME="$PG_NAME" \
REDIS_NAME="$REDIS_NAME" \
DATABASE_URL="$DATABASE_URL" \
EVIDENCE_PATH="docs/evidence/failure-injection.json" \
TS_NODE_TRANSPILE_ONLY=1 \
NODE_PATH="packages/wallet/node_modules:packages/database/node_modules:apps/gateway/node_modules:node_modules" \
  npx ts-node --project apps/gateway/tsconfig.json scripts/failure-injection.ts
SWEEP_EXIT=$?
set -e

# Leave the stack as we found it, even on failure.
docker start "$PG_NAME" >/dev/null 2>&1 || true
docker start "$REDIS_NAME" >/dev/null 2>&1 || true

if [ $SWEEP_EXIT -ne 0 ]; then
  echo -e "\033[1;31mFAILURE-INJECTION SWEEP FAILED (exit $SWEEP_EXIT)\033[0m" >&2
  exit $SWEEP_EXIT
fi

echo -e "\033[1;32m═══════════════════════════════════════════════════════════════"
echo "  FAILURE-INJECTION SWEEP: ALL INVARIANTS HELD"
echo "  Evidence: docs/evidence/failure-injection.json"
echo -e "═══════════════════════════════════════════════════════════════\033[0m"
