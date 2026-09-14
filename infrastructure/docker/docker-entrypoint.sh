#!/bin/sh
#
# Gateway container entrypoint.
#
# Applies pending Prisma migrations, then starts the gateway. This exists
# because the image previously ran `node dist/apps/gateway/main.js` directly
# and nothing ever migrated the database: a fresh deploy came up against an
# empty schema, reported healthy, and failed every API call. (The Kubernetes
# manifests worked around it with a separate migration Job; Railway, Docker
# Compose and bare VMs had no such step at all.)
#
# Migration is idempotent — `prisma migrate deploy` is a no-op once the
# database is up to date, and Prisma takes an advisory lock so concurrent
# replicas cannot interleave.
#
# RUN_MIGRATIONS_ON_START:
#   true  (default) — migrate on boot. Right for single-service deploys
#                     (Railway, Docker Compose, a VM).
#   false          — skip; the schema is managed elsewhere (e.g. Kubernetes,
#                     which ships infrastructure/kubernetes/migrations-job.yaml).
#                     The gateway still refuses to start against an unmigrated
#                     schema — see apps/gateway/src/common/schema-guard.ts.
#
set -eu

DATABASE_DIR=/app/packages/database
PRISMA_CLI="$DATABASE_DIR/node_modules/.bin/prisma"

log() { echo "[entrypoint] $*"; }

if [ "${RUN_MIGRATIONS_ON_START:-true}" = "true" ]; then
  if [ ! -x "$PRISMA_CLI" ]; then
    # Fail loudly rather than silently booting an unmigrated gateway.
    log "ERROR: Prisma CLI not found at $PRISMA_CLI — cannot apply migrations."
    log "       Set RUN_MIGRATIONS_ON_START=false if migrations are managed externally."
    exit 1
  fi

  log "applying database migrations (prisma migrate deploy)"
  cd "$DATABASE_DIR"
  if ! "$PRISMA_CLI" migrate deploy --schema prisma/schema.prisma; then
    log "ERROR: prisma migrate deploy failed — refusing to start the gateway."
    log "       Fix the migration error above; starting anyway would serve traffic"
    log "       against a partial schema."
    exit 1
  fi
  log "migrations applied"
  cd /app
else
  log "RUN_MIGRATIONS_ON_START=${RUN_MIGRATIONS_ON_START} — skipping migrations (managed externally)"
fi

exec "$@"
