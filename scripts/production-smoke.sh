#!/usr/bin/env bash
#
# Production smoke check: the DEPLOYED dashboard must point at a LIVE gateway.
#
# Why this exists: the dashboard spent weeks deployed with
# `http://localhost:3000` baked into its client bundle, so every page failed in
# the visitor's browser with ERR_CONNECTION_REFUSED and rendered as a wall of
# loading placeholders — while the build was green and the deploy reported
# success. Nothing in CI could see it, because a bundle pointing at the
# visitor's own machine is indistinguishable from a healthy build *until it is
# loaded in a browser*. This script asserts the two things a green deploy does
# not:
#
#   1. the live bundle is configured with a real, non-loopback gateway URL
#      (and it is the expected one when GATEWAY_URL is given — drift detection);
#   2. that URL answers as a gateway right now.
#
# Checks (all must pass):
#   1. dashboard_reachable    the deployed dashboard serves the built app
#   2. gateway_baked_in       the client bundle inlines a real gateway URL
#   3. gateway_health         GET /health       → 200, status ok
#   4. gateway_ready          GET /health/ready → 200, Postgres and Redis ok
#   5. gateway_serves_api     GET /api/v1/providers → 401 (route exists, auth on)
#   6. dashboard_serves_api   in same-origin mode: the dashboard's OWN
#                             /api/v1/providers answers as the gateway, i.e. the
#                             rewrite that makes the session cookie first-party
#                             is actually proxying
#   7. browser_reachability   CORS preflight from the dashboard origin is allowed
#                             — only in absolute mode; a same-origin proxy makes
#                             no cross-origin request, so it self-skips
#
# Usage:
#   bash scripts/production-smoke.sh
#   GATEWAY_URL=https://gw.example.com bash scripts/production-smoke.sh
#   pnpm smoke:production
#
# Environment variables:
#   DASHBOARD_URL   deployed dashboard origin (default: the Vercel production
#                   alias for this project)
#   GATEWAY_URL     the gateway the dashboard MUST be pointing at. When unset it
#                   is discovered from the deployed bundle and only its
#                   liveness is checked.
#   EVIDENCE_OUT    JSON report path (default docs/evidence/production-smoke.json)
#   SMOKE_TIMEOUT   per-request timeout in seconds (default 20)
#
# Exits non-zero if any check fails, so it can gate a deploy or run on a
# schedule to catch drift.
set -euo pipefail

DASHBOARD_URL="${DASHBOARD_URL:-https://pay-per-token-llm-gateway-dashboard.vercel.app}"
EXPECTED_GATEWAY_URL="${GATEWAY_URL:-}"
EVIDENCE_OUT="${EVIDENCE_OUT:-docs/evidence/production-smoke.json}"
SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-20}"

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } /^[ \t]*$/ { print ""; next } { exit }' "$0"
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $arg (expected --help or nothing — configure via env vars)" >&2
      exit 1
      ;;
  esac
done

WORK_DIR="$(mktemp -d)"
RESULTS_FILE="${WORK_DIR}/results.tsv"
trap 'rm -rf "$WORK_DIR"' EXIT

FAILURES=0

echo "Production smoke check"
echo "  dashboard: ${DASHBOARD_URL}"
echo "  gateway:   ${EXPECTED_GATEWAY_URL:-<discover from the deployed bundle>}"
echo ""

record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS_FILE"; }
pass() { record pass "$1" "$2"; echo "  ✅ $1 — $2"; }
fail() { record fail "$1" "$2"; echo "  ❌ $1 — $2"; FAILURES=$((FAILURES + 1)); }
skip() { record skip "$1" "$2"; echo "  ⏭️  $1 — $2"; }

# Fetch a URL into a file and print the HTTP status (000 when the request never
# completed). Extra curl arguments are passed through.
fetch() { # fetch <url> <out-file> [curl args...]
  local url="$1"; shift
  local out="$1"; shift
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' --max-time "$SMOKE_TIMEOUT" "$@" "$url" 2>/dev/null || true)"
  printf '%s' "${code:-000}"
}

# Read a dotted path out of a JSON file (empty string when absent/unparseable).
json_get() { # json_get <file> <dotted.path>
  node -e '
    const fs = require("fs");
    const read = (p) => {
      try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return undefined; }
    };
    let cur = read(process.argv[1]);
    for (const key of process.argv[2].split(".")) {
      if (cur === null || typeof cur !== "object" || !(key in cur)) { process.stdout.write(""); process.exit(0); }
      cur = cur[key];
    }
    process.stdout.write(typeof cur === "string" ? cur : JSON.stringify(cur));
  ' "$1" "$2"
}

host_of() { printf '%s' "${1#*://}" | cut -d/ -f1; }

# ── 1. The deployed dashboard serves the built app ────────────────────────────

HTML_FILE="${WORK_DIR}/dashboard.html"
HTTP_CODE="$(fetch "$DASHBOARD_URL/" "$HTML_FILE")"
if [ "$HTTP_CODE" != "200" ]; then
  fail dashboard_reachable "GET ${DASHBOARD_URL}/ returned HTTP ${HTTP_CODE}"
elif ! grep -q '/_next/static/' "$HTML_FILE"; then
  fail dashboard_reachable "HTTP 200 but no Next.js client assets — that is not the built dashboard"
else
  pass dashboard_reachable "HTTP 200 with Next.js client assets"
fi

# ── 2. The client bundle inlines a real gateway URL ───────────────────────────
#
# Next.js substitutes the literal expression `process.env.NEXT_PUBLIC_GATEWAY_URL`
# into the browser bundle at BUILD time, so the only truthful place to read the
# dashboard's gateway is the served JavaScript — the Vercel project's env var
# says nothing about the bundle that is actually live.

GATEWAY_URL_RESOLVED=""
GATEWAY_URL_SOURCE="discovered"
BUNDLE_FILE="${WORK_DIR}/chunk.js"
NOT_INLINED=0
SAME_ORIGIN="false"

# A file + `while read` rather than `mapfile`, which macOS's bash 3.2 lacks.
CHUNK_LIST="${WORK_DIR}/chunks.txt"
grep -o '/_next/static/chunks/[^"]*\.js' "$HTML_FILE" | sort -u > "$CHUNK_LIST" || true
CHUNK_COUNT="$(wc -l < "$CHUNK_LIST" | tr -d ' ')"

if [ "$CHUNK_COUNT" -eq 0 ]; then
  fail gateway_baked_in "the dashboard HTML references no client chunks"
else
  while IFS= read -r chunk; do
    [ -n "$chunk" ] || continue
    fetch "${DASHBOARD_URL}${chunk}" "$BUNDLE_FILE" >/dev/null
    # Compiled shape: {NODE_ENV:"production",NEXT_PUBLIC_GATEWAY_URL:"https://…"}
    # Same-origin mode changes what has to be true of the deployment, so read
    # it from the same source of truth as the URL: the served bundle.
    mode="$(grep -oE 'NEXT_PUBLIC_GATEWAY_SAME_ORIGIN"?\]?[[:space:]]*[:=][[:space:]]*"[^"]+"' "$BUNDLE_FILE" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    if [ "$mode" = "true" ]; then SAME_ORIGIN="true"; fi
    found="$(grep -oE 'NEXT_PUBLIC_GATEWAY_URL"?\]?[[:space:]]*[:=][[:space:]]*"[^"]+"' "$BUNDLE_FILE" 2>/dev/null | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)"
    if [ -z "$found" ] && grep -q 'process\.env\.NEXT_PUBLIC_GATEWAY_URL' "$BUNDLE_FILE" 2>/dev/null; then
      NOT_INLINED=1
    fi
    if [ -n "$found" ]; then
      GATEWAY_URL_RESOLVED="$(printf '%s' "${found%/}" | tr -d '[:space:]')"
      break
    fi
  done < "$CHUNK_LIST"

  if [ -z "$GATEWAY_URL_RESOLVED" ]; then
    if [ "$NOT_INLINED" = "1" ]; then
      fail gateway_baked_in "the bundle reads process.env.NEXT_PUBLIC_GATEWAY_URL at runtime — Next.js only substitutes it at build time, so it is always undefined in the browser"
    else
      fail gateway_baked_in "no gateway URL is inlined in ${CHUNK_COUNT} client chunk(s): this build was shipped without NEXT_PUBLIC_GATEWAY_URL and renders a configuration error"
    fi
  else
    case "$GATEWAY_URL_RESOLVED" in
      *localhost*|*127.0.0.1*|*0.0.0.0*|*\[::1\]*)
        fail gateway_baked_in "the live bundle points at ${GATEWAY_URL_RESOLVED} — that is the visitor's own machine, not a gateway (the original production regression)"
        ;;
      *)
        if [ -n "$EXPECTED_GATEWAY_URL" ] && [ "${EXPECTED_GATEWAY_URL%/}" != "$GATEWAY_URL_RESOLVED" ]; then
          GATEWAY_URL_SOURCE="expected"
          fail gateway_baked_in "the live bundle points at ${GATEWAY_URL_RESOLVED}, expected ${EXPECTED_GATEWAY_URL%/} (rebuild the dashboard after changing NEXT_PUBLIC_GATEWAY_URL — it is inlined at build time)"
        else
          if [ -n "$EXPECTED_GATEWAY_URL" ]; then GATEWAY_URL_SOURCE="expected"; fi
          if [ "$SAME_ORIGIN" = "true" ]; then
            pass gateway_baked_in "the bundle targets ${GATEWAY_URL_RESOLVED} as its proxy destination (browser calls go to the dashboard's own /api/v1)"
          else
            pass gateway_baked_in "the live bundle calls ${GATEWAY_URL_RESOLVED}"
          fi
        fi
        ;;
    esac
  fi
fi

# ── 3–5. That gateway is alive and serving the dashboard's API ────────────────

if [ -z "$GATEWAY_URL_RESOLVED" ]; then
  skip gateway_health "no gateway URL to check"
  skip gateway_ready "no gateway URL to check"
  skip gateway_serves_api "no gateway URL to check"
  skip dashboard_serves_api "no gateway URL to check"
  skip browser_reachability "no gateway URL to check"
else
  HEALTH_FILE="${WORK_DIR}/health.json"
  CODE="$(fetch "${GATEWAY_URL_RESOLVED}/health" "$HEALTH_FILE")"
  HEALTH_STATUS="$(json_get "$HEALTH_FILE" status)"
  if [ "$CODE" = "200" ] && [ "$HEALTH_STATUS" = "ok" ]; then
    pass gateway_health "GET /health → 200 status=ok (version $(json_get "$HEALTH_FILE" version), network $(json_get "$HEALTH_FILE" network))"
  else
    fail gateway_health "GET ${GATEWAY_URL_RESOLVED}/health returned HTTP ${CODE} with status '${HEALTH_STATUS}'"
  fi

  READY_FILE="${WORK_DIR}/ready.json"
  CODE="$(fetch "${GATEWAY_URL_RESOLVED}/health/ready" "$READY_FILE")"
  DB_STATUS="$(json_get "$READY_FILE" checks.database.status)"
  REDIS_STATUS="$(json_get "$READY_FILE" checks.redis.status)"
  if [ "$CODE" = "200" ] && [ "$DB_STATUS" = "ok" ] && [ "$REDIS_STATUS" = "ok" ]; then
    pass gateway_ready "GET /health/ready → 200 (database ok, redis ok)"
  else
    fail gateway_ready "GET /health/ready returned HTTP ${CODE} (database '${DB_STATUS}', redis '${REDIS_STATUS}')"
  fi

  API_FILE="${WORK_DIR}/providers.json"
  CODE="$(fetch "${GATEWAY_URL_RESOLVED}/api/v1/providers" "$API_FILE" -H "Origin: ${DASHBOARD_URL}")"
  case "$CODE" in
    401)
      pass gateway_serves_api "GET /api/v1/providers → 401 signed out (route exists, auth enforced)"
      ;;
    200)
      fail gateway_serves_api "GET /api/v1/providers → 200 without a session: auth is not enforced on this gateway"
      ;;
    404)
      fail gateway_serves_api "GET /api/v1/providers → 404: ${GATEWAY_URL_RESOLVED} is reachable but is not serving the gateway API"
      ;;
    *)
      fail gateway_serves_api "GET /api/v1/providers returned HTTP ${CODE}"
      ;;
  esac

  # ── 6. In same-origin mode, the dashboard must proxy the API itself ─────────
  #
  # This is the check that matters when the deployment routes through its own
  # origin: the session cookie is only first-party if a request to
  # <dashboard>/api/v1/* is answered by the gateway through the rewrite. A 404
  # here means every call the page makes fails, and the cookie the gateway sets
  # would go back to being cross-site.
  if [ "$SAME_ORIGIN" = "true" ]; then
    PROXY_FILE="${WORK_DIR}/proxy-providers.json"
    CODE="$(fetch "${DASHBOARD_URL}/api/v1/providers" "$PROXY_FILE" -H "Origin: ${DASHBOARD_URL}")"
    case "$CODE" in
      401)
        pass dashboard_serves_api "GET ${DASHBOARD_URL}/api/v1/providers → 401 through the dashboard's own origin (the same-origin proxy reaches the gateway, so its session cookie is first-party)"
        ;;
      404)
        fail dashboard_serves_api "GET ${DASHBOARD_URL}/api/v1/providers → 404: the same-origin rewrite is not configured on this deployment, so every call from the page fails"
        ;;
      000)
        fail dashboard_serves_api "GET ${DASHBOARD_URL}/api/v1/providers did not respond — the proxy has no reachable gateway behind it"
        ;;
      *)
        fail dashboard_serves_api "GET ${DASHBOARD_URL}/api/v1/providers returned HTTP ${CODE} (expected 401 while signed out)"
        ;;
    esac
  else
    skip dashboard_serves_api "the client calls the gateway origin directly (NEXT_PUBLIC_GATEWAY_SAME_ORIGIN is not enabled)"
  fi

  # ── 7. A browser on the dashboard origin may call it ────────────────────────
  #
  # Cross-origin only: browser requests carry the dashboard's Origin, so the
  # gateway has to answer its preflight. With a same-origin proxy in front of the
  # gateway this is unnecessary, so it skips rather than fails.
  if [ "$SAME_ORIGIN" = "true" ]; then
    skip browser_reachability "the gateway is reached through the dashboard's own origin — no cross-origin preflight is involved"
  elif [ "$(host_of "$DASHBOARD_URL")" = "$(host_of "$GATEWAY_URL_RESOLVED")" ]; then
    skip browser_reachability "the gateway is same-origin with the dashboard — no preflight needed"
  else
    PREFLIGHT_HEADERS="${WORK_DIR}/preflight.headers"
    CODE="$(fetch "${GATEWAY_URL_RESOLVED}/api/v1/providers" /dev/null -D "$PREFLIGHT_HEADERS" -X OPTIONS \
      -H "Origin: ${DASHBOARD_URL}" -H 'Access-Control-Request-Method: GET' -H 'Access-Control-Request-Headers: content-type')"
    ALLOW_ORIGIN="$(grep -i '^access-control-allow-origin:' "$PREFLIGHT_HEADERS" 2>/dev/null | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)"
    ALLOW_CREDS="$(grep -i '^access-control-allow-credentials:' "$PREFLIGHT_HEADERS" 2>/dev/null | tail -1 | tr -d '\r' | cut -d' ' -f2- || true)"
    if [ "$ALLOW_ORIGIN" = "$DASHBOARD_URL" ] && [ "$ALLOW_CREDS" = "true" ]; then
      pass browser_reachability "preflight from ${DASHBOARD_URL} → allow-origin echoed, allow-credentials true, HTTP ${CODE}"
    else
      fail browser_reachability "preflight from ${DASHBOARD_URL} returned allow-origin '${ALLOW_ORIGIN:-<none>}' / allow-credentials '${ALLOW_CREDS:-<none>}' (HTTP ${CODE}) — add ${DASHBOARD_URL} to the gateway's CORS_ORIGINS"
    fi
  fi
fi

# ── Evidence ─────────────────────────────────────────────────────────────────

node -e '
  const fs = require("fs");
  const path = require("path");
  const [resultsFile, out, dashboardUrl, gatewayUrl, gatewaySource, sameOrigin] = process.argv.slice(1);
  const steps = {};
  for (const line of fs.readFileSync(resultsFile, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const [status, check, detail] = line.split("\t");
    steps[check] = { status, detail: detail || "" };
  }
  const report = {
    runAt: new Date().toISOString(),
    dashboardUrl,
    gatewayUrl,
    gatewayUrlSource: gatewaySource,
    sameOriginProxy: sameOrigin,
    steps,
    passed: Object.values(steps).every((s) => s.status !== "fail"),
  };
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
' "$RESULTS_FILE" "$EVIDENCE_OUT" "$DASHBOARD_URL" "$GATEWAY_URL_RESOLVED" "$GATEWAY_URL_SOURCE" "$SAME_ORIGIN"

echo ""
echo "Evidence written to ${EVIDENCE_OUT}"
if [ "$FAILURES" -gt 0 ]; then
  echo ""
  echo "❌ Production smoke check FAILED (${FAILURES} check(s)) — the deployed dashboard is not pointed at a live gateway." >&2
  exit 1
fi
echo ""
echo "✅ Production smoke check passed — ${DASHBOARD_URL} is pointed at a live gateway."
