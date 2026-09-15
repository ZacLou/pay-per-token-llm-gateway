#!/usr/bin/env bash
#
# Enforce the Soroban 64 KiB per-contract deploy limit on built WASM.
#
# One implementation, because the gate has to hold wherever an artifact is made
# or shipped — and it previously existed only inside ci.yml, while
# `docs/VERIFICATION.md` advertised `pnpm build:contracts` as "wasm + size gate"
# and `deploy-contracts.sh` uploaded whatever it had just built unchecked. Three
# copies of the limit would drift; there is exactly one:
#
#   * CI             — .github/workflows/ci.yml (`contracts` job)
#   * local build    — scripts/build-contracts.sh (`pnpm build:contracts`)
#   * deployment     — scripts/deploy-contracts.sh, before each upload
#
# Usage:
#   bash scripts/check-contract-sizes.sh                 # discover all 3 artifacts
#   bash scripts/check-contract-sizes.sh <wasm> [...]    # check explicit files
#
# Environment:
#   CONTRACTS_DIR              artifact root to discover under (default: ./contracts)
#   CONTRACT_SIZE_LIMIT_BYTES  override the limit (used by the gate's own tests)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONTRACTS_DIR="${CONTRACTS_DIR:-${ROOT_DIR}/contracts}"
LIMIT_BYTES="${CONTRACT_SIZE_LIMIT_BYTES:-65536}"
CONTRACTS=(payment-verifier credit-escrow multisig)

# `wc -c` rather than `stat -c%s`: the GNU form is unusable on macOS/BSD, where
# contributors also build, and would fail the gate for the wrong reason.
size_of() { wc -c <"$1" | tr -d '[:space:]'; }

files=()
if [ "$#" -gt 0 ]; then
  files=("$@")
else
  for contract in "${CONTRACTS[@]}"; do
    # Take the newest artifact rather than a hardcoded target dir: CI's
    # `cargo build --target wasm32-unknown-unknown` writes wasm32-unknown-unknown,
    # while `stellar contract build` has written wasm32v1-none since CLI 23.
    # A gate that silently checked nothing there would be worse than no gate.
    artifact="$(ls -t "${CONTRACTS_DIR}/${contract}/target"/*/release/*.wasm 2>/dev/null | head -n 1 || true)"
    if [ -z "$artifact" ]; then
      echo "::error::No WASM artifact for '${contract}' under ${CONTRACTS_DIR}/${contract}/target/*/release/ — build it first (pnpm build:contracts)"
      exit 1
    fi
    files+=("$artifact")
  done
fi

status=0
for file in "${files[@]}"; do
  if [ ! -f "$file" ]; then
    echo "::error::WASM artifact not found: ${file}"
    exit 1
  fi
  bytes="$(size_of "$file")"
  kib="$(awk -v b="$bytes" 'BEGIN { printf "%.1f", b / 1024 }')"
  if [ "$bytes" -gt "$LIMIT_BYTES" ]; then
    echo "::error::$(basename "$file") is ${kib} KiB (${bytes} bytes) — exceeds the $((LIMIT_BYTES / 1024)) KiB Soroban deploy limit"
    status=1
  else
    echo "✅ $(basename "$file") ${kib} KiB (${bytes} bytes) — within the $((LIMIT_BYTES / 1024)) KiB limit"
  fi
done

if [ "$status" -ne 0 ]; then
  echo "❌ Contract size gate failed: an artifact is too large to deploy." >&2
  exit 1
fi

echo "✅ Contract size gate passed (${#files[@]} artifact(s))"
