#!/usr/bin/env bash
# verify.sh — replicate Loom's loom-health-v1 probe locally so an operator can
# confirm a target endpoint will be accepted. Exit code 0 = Loom would record
# pass/warn; exit code 1 = Loom would record fail.
#
# Usage:
#   ./verify.sh <url> [--strict] [--timeout-ms 5000]
#
# Notes:
#   - Mirrors src/workers/jobs/service-probe.ts::probeLoomHealth and
#     src/lib/loom-health.ts::parseHealthResponse.
#   - Requires `curl` and `jq`.

set -euo pipefail

URL="${1:-}"
STRICT=false
TIMEOUT_MS=5000

shift || true
while [[ $# -gt 0 ]]; do
  case "$1" in
    --strict) STRICT=true ;;
    --timeout-ms) TIMEOUT_MS="$2"; shift ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
  shift
done

if [[ -z "$URL" ]]; then
  echo "usage: $0 <url> [--strict] [--timeout-ms 5000]" >&2
  exit 2
fi
if ! command -v jq >/dev/null; then
  echo "verify.sh requires jq" >&2
  exit 2
fi

TIMEOUT_S=$(( TIMEOUT_MS / 1000 ))
[[ $TIMEOUT_S -lt 1 ]] && TIMEOUT_S=1

TMP=$(mktemp)
trap 'rm -f "$TMP"' EXIT

# shellcheck disable=SC2086
HTTP_CODE=$(curl -sS -o "$TMP" -w "%{http_code}" \
  --max-time "$TIMEOUT_S" \
  -H 'Accept: application/health+json, application/json' \
  "$URL" || echo "000")

echo "URL:       $URL"
echo "HTTP:      $HTTP_CODE"

if [[ "$HTTP_CODE" == "000" ]]; then
  echo "RESULT:    fail (request error / timeout)"
  exit 1
fi

# Try to parse JSON.
if ! jq -e . "$TMP" >/dev/null 2>&1; then
  if $STRICT; then
    echo "RESULT:    fail (non-JSON body, strict schema)"
    exit 1
  fi
  if [[ "$HTTP_CODE" =~ ^2 ]]; then
    echo "RESULT:    pass (non-JSON 2xx, legacy permissive)"
    exit 0
  fi
  echo "RESULT:    fail (non-JSON, non-2xx)"
  exit 1
fi

STATUS=$(jq -r '.status // "MISSING"' "$TMP")
case "$STATUS" in
  pass|warn|fail) ;;
  *)
    echo "RESULT:    fail (invalid status: $STATUS)"
    exit 1
    ;;
esac

# 503 forces fail regardless of body (matches probe behavior).
if [[ "$HTTP_CODE" == "503" ]]; then
  STATUS="fail"
fi

WARNINGS=()
[[ $(jq -r '.releaseId // ""' "$TMP") == "" ]] && WARNINGS+=("missing-releaseId")
$STRICT && [[ $(jq -r '.version // ""' "$TMP") == "" ]] && WARNINGS+=("missing-version")

echo "serviceId: $(jq -r '.serviceId // "(none)"' "$TMP")"
echo "version:   $(jq -r '.version // "(none)"' "$TMP")"
echo "releaseId: $(jq -r '.releaseId // "(none)"' "$TMP")"
echo "checks:    $(jq -r '.checks // {} | keys | join(",")' "$TMP")"
if (( ${#WARNINGS[@]} > 0 )); then
  echo "warnings:  ${WARNINGS[*]}"
fi
echo "RESULT:    $STATUS"

[[ "$STATUS" == "fail" ]] && exit 1
exit 0
