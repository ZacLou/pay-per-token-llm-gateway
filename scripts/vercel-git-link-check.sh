#!/usr/bin/env bash
#
# Report whether the Vercel project's Git integration can still read the
# repository — i.e. whether pushes will deploy.
#
# Why this exists: a project resolves its repository through
# `link.gitCredentialId`, the credential created for the GitHub App installation
# on whichever GitHub account owned the repository when it was connected.
# **Transferring the repository to another owner** leaves that credential valid
# but no longer covering the repository, so pushes produce *no deployment at
# all*: no error, no failed run, an unchanged green last deployment. The two
# symptoms that do show up are `errorCode: "git_info_fail"` on a deployment
# triggered from a commit, and `repo_not_found` when reconnecting the repository
# in the Git tab — *"Make sure there are no typos and that you have access to
# it"* — about a repository that is right there and spelled correctly. A rename
# of the same account is harmless; a transfer is not, and the repo **id** stays
# the same across a transfer, so a matching id does not mean the link is healthy.
# See DEPLOYMENT.md §2.5.
#
# Usage:
#   bash scripts/vercel-git-link-check.sh
#   bash scripts/vercel-git-link-check.sh --repo mallonepay/pay-per-token-llm-gateway
#   pnpm vercel:git-link-check
#
# Environment variables:
#   VERCEL_TOKEN       required — vercel.com/account/tokens
#   VERCEL_PROJECT_ID  required unless `.vercel/project.json` exists (from
#                      `vercel link`); the project's id, not its name
#   VERCEL_TEAM_ID     optional — the team/org id, sent as ?teamId=; falls back
#                      to `orgId` in `.vercel/project.json`
#   GITHUB_TOKEN       optional — only needed to read a private repository
#   MAX_GIT_DEPLOY_AGE_DAYS
#                      warn when the newest git-sourced deployment is older than
#                      this (default 14). A warning, not a failure: a quiet
#                      fortnight is not a broken integration.
#   EVIDENCE_OUT       optional — write the report as JSON to this path. Unlike
#                      the production smoke check there is no default file, so
#                      running this leaves the working tree alone.
#
# Exits non-zero when the link cannot be trusted (owner mismatch, unreadable
# repo, unparseable API response). Diagnosing this by hand is two API calls; the
# point of the script is that the comparison is done the same way every time.
set -euo pipefail

REPO_SLUG=""
PROJECT_ID="${VERCEL_PROJECT_ID:-}"
TEAM_ID="${VERCEL_TEAM_ID:-}"
MAX_AGE_DAYS="${MAX_GIT_DEPLOY_AGE_DAYS:-14}"

# Both `--flag value` and `--flag=value` are accepted: the header documents the
# spaced form and nobody should have to remember which one a script wants.
while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) REPO_SLUG="${2:?--repo needs owner/name}"; shift 2 ;;
    --repo=*) REPO_SLUG="${1#--repo=}"; shift ;;
    --project) PROJECT_ID="${2:?--project needs a project id}"; shift 2 ;;
    --project=*) PROJECT_ID="${1#--project=}"; shift ;;
    --team) TEAM_ID="${2:?--team needs a team id}"; shift 2 ;;
    --team=*) TEAM_ID="${1#--team=}"; shift ;;
    -h|--help)
      # Print the header comment block (skip the shebang line, stop at the code).
      awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } /^[ \t]*$/ { print ""; next } { exit }' "$0"
      exit 0
      ;;
    *)
      echo "❌ Unknown argument: $1 (expected --repo, --project, --team, --help, or nothing)" >&2
      exit 1
      ;;
  esac
done

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 'node' is required to parse the API responses." >&2
  exit 1
fi

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "❌ VERCEL_TOKEN is not set." >&2
  echo "   Create one at https://vercel.com/account/tokens and export it." >&2
  exit 1
fi

# `vercel link` writes the ids here; use them when the environment is silent.
if [ -f .vercel/project.json ]; then
  [ -n "$PROJECT_ID" ] || PROJECT_ID="$(node -pe 'require("./.vercel/project.json").projectId || ""')"
  [ -n "$TEAM_ID" ] || TEAM_ID="$(node -pe 'require("./.vercel/project.json").orgId || ""')"
fi

if [ -z "$PROJECT_ID" ]; then
  echo "❌ No project to check: set VERCEL_PROJECT_ID (or run \`vercel link\` first)." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
RESULTS_FILE="${WORK_DIR}/results.tsv"
trap 'rm -rf "$WORK_DIR"' EXIT

FAILURES=0

record() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS_FILE"; }
pass() { record pass "$1" "$2"; echo "  ✅ $1 — $2"; }
fail() { record fail "$1" "$2"; echo "  ❌ $1 — $2"; FAILURES=$((FAILURES + 1)); }
warn() { record warn "$1" "$2"; echo "  ⚠️  $1 — $2"; }

# curl reports 000 in `%{http_code}` when nothing was received, and a failed
# connection also exits non-zero — so strip everything but digits and take the
# last three, which is the status code in every case.
clean_code() {
  local digits
  digits="$(printf '%s' "$1" | tr -cd '0-9')"
  digits="${digits:-000}"
  printf '%s\n' "${digits: -3}"
}

api() { # api <url> <out-file> [extra curl args...]
  local url="$1"; shift
  local out="$1"; shift
  local code
  code="$(curl -sS -o "$out" -w '%{http_code}' --max-time 30 \
    -H "Authorization: Bearer ${VERCEL_TOKEN}" "$@" "$url" 2>/dev/null || true)"
  clean_code "$code"
}

# ── Which repository to check ────────────────────────────────────────────────
#
# Identify it without asking: the origin remote is the repository being
# deployed. An explicit name is available for a checkout whose remote is a fork
# or whose origin is not GitHub.

if [ -z "$REPO_SLUG" ]; then
  origin="$(git remote get-url origin 2>/dev/null || true)"
  case "$origin" in
    https://github.com/*) REPO_SLUG="${origin#https://github.com/}" ;;
    git@github.com:*) REPO_SLUG="${origin#git@github.com:}" ;;
  esac
  REPO_SLUG="${REPO_SLUG%.git}"
fi

if [ -z "$REPO_SLUG" ]; then
  echo "❌ Could not determine the repository: no GitHub 'origin' remote here." >&2
  echo "   Pass it explicitly:  --repo owner/name" >&2
  exit 1
fi

REPO_OWNER="${REPO_SLUG%%/*}"
REPO_NAME="${REPO_SLUG##*/}"

echo "Vercel Git integration check"
echo "  project:  ${PROJECT_ID}"
echo "  repo:     ${REPO_SLUG}"
echo ""

# ── 1. GitHub's view: who owns the repository now ────────────────────────────

GITHUB_JSON="${WORK_DIR}/github.json"
GH_AUTH=()
[ -n "${GITHUB_TOKEN:-}" ] && GH_AUTH=(-H "Authorization: Bearer ${GITHUB_TOKEN}")

GH_CODE="$(curl -sS -o "$GITHUB_JSON" -w '%{http_code}' --max-time 30 \
  ${GH_AUTH[@]+"${GH_AUTH[@]}"} \
  -H 'Accept: application/vnd.github+json' \
  "https://api.github.com/repos/${REPO_SLUG}" 2>/dev/null || true)"
GH_CODE="$(clean_code "$GH_CODE")"

REPO_OWNER_ID=""
REPO_ID=""
REPO_LOGIN="$REPO_OWNER"
REPO_PRIVATE=""

if [ "$GH_CODE" = "200" ]; then
  # Tab-separated: an empty field must stay a field (bash collapses runs of
  # whitespace when splitting, which would shift every value after it).
  IFS=$'\t' read -r REPO_OWNER_ID REPO_ID REPO_LOGIN REPO_PRIVATE <<<"$(node -e '
    const r = require(process.argv[1]);
    console.log(
      [r.owner.id, r.id, r.owner.login, r.private].map(String).join("\t"),
    );
  ' "$GITHUB_JSON")"
  pass repo_readable "GitHub: ${REPO_LOGIN}/${REPO_NAME} — repo id ${REPO_ID}, owner id ${REPO_OWNER_ID}$([ "$REPO_PRIVATE" = "true" ] && echo ' (private)')"
else
  fail repo_readable "GitHub returned HTTP ${GH_CODE} for ${REPO_SLUG} — its owner and id cannot be compared against the project's link. For a private repository, export GITHUB_TOKEN (a token that can read it)."
fi

# ── 2. Vercel's view: the owner the project is linked to ─────────────────────

PROJECT_JSON="${WORK_DIR}/project.json"
TEAM_QUERY=""
[ -n "$TEAM_ID" ] && TEAM_QUERY="?teamId=${TEAM_ID}"

PROJ_CODE="$(api "https://api.vercel.com/v9/projects/${PROJECT_ID}${TEAM_QUERY}" "$PROJECT_JSON")"

LINK_TYPE=""
LINK_OWNER=""
LINK_OWNER_ID=""
LINK_REPO=""
LINK_REPO_ID=""
LINK_CRED=""

if [ "$PROJ_CODE" = "200" ]; then
  IFS=$'\t' read -r LINK_TYPE LINK_OWNER LINK_OWNER_ID LINK_REPO_ID LINK_CRED <<<"$(node -e '
    const p = require(process.argv[1]);
    const l = p.link || {};
    console.log(
      [l.type, l.org, l.repoOwnerId, l.repoId, l.gitCredentialId]
        .map((v) => String(v === undefined || v === null ? "" : v))
        .join("\t"),
    );
  ' "$PROJECT_JSON")"
else
  fail project_readable "Vercel returned HTTP ${PROJ_CODE} for project ${PROJECT_ID} — check VERCEL_TOKEN, VERCEL_PROJECT_ID and (for a team project) VERCEL_TEAM_ID."
fi

if [ "$LINK_TYPE" = "" ] && [ "$PROJ_CODE" = "200" ]; then
  fail link_present "the project has no Git repository connected at all — connect one in Vercel → project → Settings → Git"
fi

# ── 3. Do they agree? ───────────────────────────────────────────────────────
#
# The owner id is the decisive comparison. The owner *name* changes on a rename
# (harmless) and the repo id survives a transfer (so it proves nothing), which
# is why the id — not either name — is what this checks.

if [ -n "$LINK_TYPE" ] && [ -n "$REPO_OWNER_ID" ]; then
  if [ "$LINK_OWNER_ID" = "$REPO_OWNER_ID" ]; then
    pass link_owner "linked to owner id ${LINK_OWNER_ID} (${LINK_OWNER}) — the repository's current owner"
  else
    fail link_owner "linked to owner id ${LINK_OWNER_ID} (${LINK_OWNER}) but the repository is owned by ${REPO_OWNER_ID} (${REPO_LOGIN}) — the credential belongs to a different account's GitHub App installation, so Vercel cannot read the repository and pushes will not deploy"
  fi

  # A rename leaves the id intact but the stored name stale; Vercel resolves by
  # id, so this is a tidiness signal rather than a fault.
  stored="$(printf '%s' "$LINK_OWNER" | tr '[:upper:]' '[:lower:]')"
  actual="$(printf '%s' "$REPO_LOGIN" | tr '[:upper:]' '[:lower:]')"
  if [ "$stored" != "$actual" ]; then
    warn link_owner_name "the project still stores '${LINK_OWNER}' where the repository is now '${REPO_LOGIN}' — harmless when the owner id matches (a rename), fixed by reconnecting the repository"
  fi

  if [ "$LINK_REPO_ID" != "$REPO_ID" ]; then
    fail link_repo "the project is linked to repo id ${LINK_REPO_ID:-<none>} but ${REPO_SLUG} is repo id ${REPO_ID} — a different repository entirely"
  else
    pass link_repo "repo id ${LINK_REPO_ID} matches, and the credential is ${LINK_CRED:-<none>}"
  fi
fi

# ── 4. Corroboration: when did git-sourced deployments last work? ────────────
#
# A healthy link is not proof that pushes deploy — the credential can be stale
# in ways the ids don't show (an App reinstall mints a new credential id). The
# deployments list is the only place that says whether Vercel has *acted* on a
# push recently.

DEPS_JSON="${WORK_DIR}/deployments.json"
DEPS_CODE="$(api "https://api.vercel.com/v6/deployments?projectId=${PROJECT_ID}&limit=100${TEAM_QUERY:+&teamId=${TEAM_ID}}" "$DEPS_JSON")"

if [ "$DEPS_CODE" = "200" ]; then
  IFS=$'\t' read -r LATEST_SOURCE LATEST_AGE LAST_GIT_AGE LAST_GIT_STATE <<<"$(node -e '
    const d = require(process.argv[1]);
    const deps = d.deployments || [];
    const days = (ms) => (Date.now() - ms) / 86400000;
    const fmt = (n) => (Number.isFinite(n) ? n.toFixed(1) : "n/a");
    const newest = deps[0];
    const git = deps.find((x) => x.source === "git");
    console.log(
      [
        newest ? newest.source || "(api/upload)" : "(none)",
        newest ? fmt(days(newest.created)) : "n/a",
        git ? fmt(days(git.created)) : "n/a",
        git ? git.readyState || "" : "",
      ].join("\t"),
    );
  ' "$DEPS_JSON")"

  echo "  ℹ️  newest deployment: ${LATEST_SOURCE}, ${LATEST_AGE} day(s) old"

  if [ "$LAST_GIT_AGE" = "n/a" ]; then
    warn observable_git_deploy "no deployment with source=git in the last 100 deployments — nothing Vercel has deployed came from a push"
  else
    over="$(node -e 'process.exit(Number(process.argv[1]) > Number(process.argv[2]) ? 0 : 1)' "$LAST_GIT_AGE" "$MAX_AGE_DAYS" && echo yes || echo no)"
    if [ "$over" = "yes" ]; then
      warn observable_git_deploy "the newest source=git deployment is ${LAST_GIT_AGE} day(s) old (${LAST_GIT_STATE}), beyond the ${MAX_AGE_DAYS}-day threshold — pushes may not be deploying (see MAX_GIT_DEPLOY_AGE_DAYS)"
    else
      pass observable_git_deploy "a source=git deployment landed ${LAST_GIT_AGE} day(s) ago (${LAST_GIT_STATE}) — Vercel is acting on pushes"
    fi
  fi
else
  warn observable_git_deploy "could not list deployments (HTTP ${DEPS_CODE}) — the link checks above stand on their own"
fi

# ── Report ──────────────────────────────────────────────────────────────────

echo ""

if [ -n "${EVIDENCE_OUT:-}" ]; then
  node -e '
    const fs = require("fs");
    const path = require("path");
    const [resultsFile, out, projectId, repoSlug, linkOwner, linkOwnerId, repoOwnerId, repoLogin, repoId, latestSource, lastGitAge] =
      process.argv.slice(1);
    const steps = {};
    for (const line of fs.readFileSync(resultsFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const [status, check, detail] = line.split("\t");
      steps[check] = { status, detail: detail || "" };
    }
    const report = {
      runAt: new Date().toISOString(),
      projectId,
      repoSlug,
      link: { org: linkOwner, repoOwnerId: linkOwnerId },
      repo: { ownerLogin: repoLogin, ownerId: repoOwnerId, repoId },
      deployments: { newestSource: latestSource, lastGitAgeDays: lastGitAge },
      steps,
      passed: Object.values(steps).every((s) => s.status !== "fail"),
    };
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  ' "$RESULTS_FILE" "$EVIDENCE_OUT" "$PROJECT_ID" "$REPO_SLUG" "${LINK_OWNER:-}" "${LINK_OWNER_ID:-}" "${REPO_OWNER_ID:-}" "${REPO_LOGIN:-}" "${REPO_ID:-}" "${LATEST_SOURCE:-}" "${LAST_GIT_AGE:-}"
  echo "Evidence written to ${EVIDENCE_OUT}"
  echo ""
fi

if [ "$FAILURES" -gt 0 ]; then
  {
    echo "❌ The Git link cannot be trusted (${FAILURES} check(s)) — pushes will not deploy."
    echo ""
    echo "Fix, in this order (both need a browser session; a project-scoped token can"
    echo "neither enumerate Git credentials nor attach one):"
    echo "  1. Install/authorize the Vercel GitHub App for the repository's CURRENT owner:"
    echo "     https://github.com/apps/vercel → Install → pick the organisation and repository."
    echo "  2. Vercel → project → Settings → Git → Disconnect, then Connect ${REPO_SLUG}."
    echo "     That writes a fresh link.gitCredentialId."
    echo ""
    echo "Then push a commit and re-run this script — observable_git_deploy should"
    echo "report a source=git deployment a few minutes old. See DEPLOYMENT.md §2.5."
  } >&2
  exit 1
fi

echo "✅ The Git link matches ${REPO_SLUG} — pushes should deploy."
