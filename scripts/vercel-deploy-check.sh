#!/usr/bin/env bash
#
# Simulate the Vercel deploy pipeline locally, end to end, before pushing.
#
#   1. `vercel pull`              — link the project and download its production
#                                   settings + environment variables into .vercel/
#   2. `vercel build --prod`      — run the project's production build exactly as
#                                   Vercel's platform does (buildCommand from
#                                   apps/dashboard/vercel.json, cwd = apps/dashboard)
#   3. `vercel deploy --prebuilt --prod` (optional, --deploy flag) — upload the
#                                   prebuilt output as a production deployment
#
# Why this exists: the dashboard deploy broke because the build ran from the
# Vercel Root Directory (apps/dashboard), where the Nx `@nx/next:build` executor
# fails with a cold cache ("ENOENT: scandir 'apps/dashboard/public'"). The fix
# (apps/dashboard/vercel.json) uses plain `pnpm exec next build`, which works
# from that directory. This script runs the same command from the same directory
# so regressions are caught locally before a deploy is triggered.
#
# Usage:
#   bash scripts/vercel-deploy-check.sh             # pull + build only
#   bash scripts/vercel-deploy-check.sh --deploy    # pull + build + deploy
#
# Required:
#   Vercel CLI installed:  npm i -g vercel
#
# Credentials (one of):
#   - `vercel login` (creates ~/.vercel/auth.json), or
#   - VERCEL_TOKEN exported (token from vercel.com/account/tokens)
#
# Linking (one of):
#   - VERCEL_ORG_ID + VERCEL_PROJECT_ID exported (non-interactive; these are the
#     same values the GitHub Action uses as secrets), or
#   - an existing link from a previous `vercel link` / `vercel pull`
#
# Environment variables:
#   VERCEL_TOKEN         Vercel access token (alternative to `vercel login`)
#   VERCEL_ORG_ID        Team ID from Vercel project Settings → General
#   VERCEL_PROJECT_ID    Project ID from Vercel project Settings → General
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DASHBOARD_DIR="${ROOT_DIR}/apps/dashboard"
DEPLOY="false"

for arg in "$@"; do
  case "$arg" in
    --deploy) DEPLOY="true" ;;
    -h|--help)
      # Print the header comment block (skip the shebang line, stop at first code).
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } /^[ \t]*$/ { print ""; next } { exit }' "$0"
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $arg (expected --deploy or nothing)" >&2
      exit 1
      ;;
  esac
done

# ── Prerequisite checks ───────────────────────

if ! command -v vercel >/dev/null 2>&1; then
  echo "❌ 'vercel' CLI not found on PATH." >&2
  echo "   Install it with:  npm i -g vercel" >&2
  exit 1
fi

if [ -z "${VERCEL_TOKEN:-}" ] && [ ! -f "${HOME}/.vercel/auth.json" ]; then
  echo "❌ No Vercel credentials found." >&2
  echo "   Either run 'vercel login' once, or export VERCEL_TOKEN." >&2
  exit 1
fi

if [ -z "${VERCEL_ORG_ID:-}" ] || [ -z "${VERCEL_PROJECT_ID:-}" ]; then
  echo "⚠️  VERCEL_ORG_ID / VERCEL_PROJECT_ID not set — 'vercel pull' may prompt"
  echo "    interactively to select the project. Export both to run non-interactively:"
  echo "    VERCEL_ORG_ID=... VERCEL_PROJECT_ID=... bash scripts/vercel-deploy-check.sh"
fi

# ── Run the pipeline from the Vercel Root Directory ──

TOTAL_STEPS=2
if [ "$DEPLOY" = "true" ]; then
  TOTAL_STEPS=3
fi
CURRENT_STEP=0

run_step() {
  CURRENT_STEP=$((CURRENT_STEP + 1))
  echo ""
  echo "═══ [$CURRENT_STEP/$TOTAL_STEPS] $* ═══"
}

cd "$DASHBOARD_DIR"

run_step "vercel pull --yes --environment=production"
vercel pull --yes --environment=production

run_step "vercel build --prod (cwd = apps/dashboard, as Vercel does)"
vercel build --prod

if [ "$DEPLOY" = "true" ]; then
  run_step "vercel deploy --prebuilt --prod"
  vercel deploy --prebuilt --prod
fi

# ── Post-build assertion: the gateway URL actually reached the CLIENT bundle ──
#
# `vercel build` succeeding proves nothing about the dashboard's ability to
# reach the gateway. Next.js only inlines the literal expression
# `process.env.NEXT_PUBLIC_*` into the browser assets, and a production build
# that ships without one renders a dead dashboard. A live production deployment
# regressed exactly this way.
run_step "Assert NEXT_PUBLIC_GATEWAY_URL was inlined into the client bundle"

BUILD_DIR="${DASHBOARD_DIR}/.vercel/output"
if [ ! -d "$BUILD_DIR" ]; then
  echo "⚠️  $BUILD_DIR not found — skipping the client-bundle assertion."
else
  # `vercel pull` writes the project's production env here.
  PULLED_ENV="${DASHBOARD_DIR}/.vercel/.env.production.local"
  EXPECTED=""
  if [ -f "$PULLED_ENV" ]; then
    EXPECTED="$(grep -E '^NEXT_PUBLIC_GATEWAY_URL=' "$PULLED_ENV" | tail -1 | cut -d= -f2- | tr -d '"'"'"' ')"
  fi
  EXPECTED="${EXPECTED:-${NEXT_PUBLIC_GATEWAY_URL:-}}"

  if [ -n "$EXPECTED" ]; then
    if grep -rqF "$EXPECTED" "$BUILD_DIR/static" 2>/dev/null; then
      echo "✅ NEXT_PUBLIC_GATEWAY_URL is inlined into the client bundle ($EXPECTED)."
    else
      echo "❌ NEXT_PUBLIC_GATEWAY_URL ($EXPECTED) is NOT in the built client assets." >&2
      echo "   The deployed dashboard would fall back to http://localhost:3000 and never load data." >&2
      exit 1
    fi
  else
    echo "⚠️  NEXT_PUBLIC_GATEWAY_URL is not set for this build — the production dashboard"
    echo "    has no gateway to call and will render a configuration error."
  fi

  if grep -rqF 'localhost:3000' "$BUILD_DIR/static" 2>/dev/null; then
    echo "   (note: the DEV_GATEWAY_URL constant is present in the bundle — expected, and"
    echo "    only selected when NODE_ENV !== 'production'.)"
  fi
fi

echo ""
echo "✅ Vercel deploy pipeline check passed — the dashboard builds cleanly from apps/dashboard."
echo "   Reminder: in Vercel → Settings → Build & Development Settings, Build Command"
echo "   should be 'Auto' — a hardcoded command there overrides apps/dashboard/vercel.json."
