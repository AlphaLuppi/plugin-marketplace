#!/usr/bin/env bash
# Screenshot an iOS simulator, handling the "which booted device?" ambiguity.
#
#   sim-shot.sh [UDID] [out.png]
#
# - With a UDID: screenshots that device (boots it if needed).
# - Without: uses the sole booted simulator; ERRORS if 0 or >1 are booted
#   (the multi-booted trap that silently screenshots the wrong device).
# Default out path: /tmp/sim-shot.png
set -uo pipefail

UDID="${1:-}"
OUT="${2:-/tmp/sim-shot.png}"
command -v xcrun >/dev/null || { echo "xcrun not found (install Xcode command line tools)"; exit 1; }

booted_udids() {
  xcrun simctl list devices booted 2>/dev/null \
    | grep -oE '\(([0-9A-F-]{36})\)' | tr -d '()'
}

if [ -z "$UDID" ]; then
  # Read into an array WITHOUT mapfile/readarray — stock macOS ships bash 3.2,
  # where those builtins don't exist.
  BOOTED=()
  while IFS= read -r u; do [ -n "$u" ] && BOOTED+=("$u"); done < <(booted_udids)
  case "${#BOOTED[@]}" in
    0) echo "No booted simulator. Boot one: xcrun simctl boot <UDID> (see: xcrun simctl list devices available)"; exit 1 ;;
    1) UDID="${BOOTED[0]}"; echo "Using sole booted device: $UDID" ;;
    *) echo "Ambiguous: ${#BOOTED[@]} simulators booted — pass an explicit UDID:"; printf '  %s\n' "${BOOTED[@]}"; exit 1 ;;
  esac
else
  # Boot the requested device if it isn't already (no-op if booted).
  xcrun simctl boot "$UDID" 2>/dev/null || true
fi

xcrun simctl io "$UDID" screenshot "$OUT" || { echo "screenshot failed for $UDID"; exit 1; }
echo "wrote $OUT (device $UDID)"
