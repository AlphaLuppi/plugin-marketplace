#!/usr/bin/env bash
# Build an Expo iOS app locally and ship it to TestFlight, applying the three
# developer-Mac pitfall fixes (fastlane presence, rsync export bug, version
# stamping). Run from the Expo app dir (the one with eas.json).
#
#   BUILD → SUBMIT → PROMOTE (external review)
#
# Reads App Store Connect config from env, falling back to
# eas.json → submit.production.ios. The only real secret is the .p8 key file
# (ASC_API_KEY_PATH); everything else is an id, safe to keep in eas.json.
#
# Env (all optional if present in eas.json):
#   ASC_APP_ID / ASC_KEY_ID / ASC_ISSUER_ID / ASC_API_KEY_PATH
#   EAS_PROFILE            build/submit profile (default: production)
#   APP_VERSION            override the computed MAJOR.MINOR.<gitcount> version
#   SKIP_PROMOTE=1         build + submit only, don't promote to external review
#   BETA_NOTE_LOCALE / BETA_NOTE_TEXT   default tester note (see promote script)
#
# Safe to Ctrl-C: a trap restores package.json and the Homebrew rsync symlink.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(pwd)"
EAS_PROFILE="${EAS_PROFILE:-production}"

log()  { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*" >&2; }
die()  { printf '\033[1;31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ -f "$APP_DIR/eas.json" ] || die "No eas.json in $APP_DIR — run this from the Expo app directory."
[ -f "$APP_DIR/package.json" ] || die "No package.json in $APP_DIR."
command -v node >/dev/null || die "node not found on PATH."
command -v npx  >/dev/null || die "npx not found on PATH."

# --- read a value from eas.json submit.production.ios, env wins -----------------
eas_get() { # $1 = json key under submit.<profile>.ios
  node -e '
    const fs=require("fs");
    const j=JSON.parse(fs.readFileSync("eas.json","utf8"));
    const p=process.argv[1], k=process.argv[2];
    const v=(((j.submit||{})[p]||{}).ios||{})[k];
    if(v!==undefined && v!==null) process.stdout.write(String(v));
  ' "$EAS_PROFILE" "$1" 2>/dev/null
}

ASC_APP_ID="${ASC_APP_ID:-$(eas_get ascAppId)}"
ASC_KEY_ID="${ASC_KEY_ID:-$(eas_get ascApiKeyId)}"
ASC_ISSUER_ID="${ASC_ISSUER_ID:-$(eas_get ascApiKeyIssuerId)}"
ASC_API_KEY_PATH="${ASC_API_KEY_PATH:-$(eas_get ascApiKeyPath)}"
ASC_API_KEY_PATH="${ASC_API_KEY_PATH:-credentials/asc-api-key.p8}"
export ASC_APP_ID ASC_KEY_ID ASC_ISSUER_ID ASC_API_KEY_PATH

# --- version: MAJOR.MINOR from package.json + PATCH = git commit count ----------
if [ -z "${APP_VERSION:-}" ]; then
  base="$(node -p "require('./package.json').version" 2>/dev/null || echo 1.0.0)"
  major_minor="$(printf '%s' "$base" | cut -d. -f1-2)"
  patch="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
  APP_VERSION="${major_minor}.${patch}"
fi
export APP_VERSION EXPECTED_VERSION="$APP_VERSION"

# --- pitfall 1: fastlane must be present ----------------------------------------
command -v fastlane >/dev/null || die "fastlane not on PATH → 'brew install fastlane' (else 'spawn fastlane ENOENT' during archive)."

# --- install the cleanup trap BEFORE mutating anything --------------------------
# Both restores are guarded, so arming the trap before the mutations happen is
# safe — and it closes the window where a Ctrl-C between the rsync move and the
# trap would leave /opt/homebrew/bin/rsync renamed machine-wide.
RSYNC_MOVED=""
PKG_BAK=""
cleanup() {
  [ -n "$PKG_BAK" ] && [ -f "$PKG_BAK" ] && cp "$PKG_BAK" "$APP_DIR/package.json" && rm -f "$PKG_BAK"
  [ -n "$RSYNC_MOVED" ] && [ -e "$RSYNC_MOVED.disabled" ] && mv "$RSYNC_MOVED.disabled" "$RSYNC_MOVED"
  return 0
}
trap cleanup EXIT INT TERM

# --- pitfall 3: move Homebrew rsync aside so openrsync is used for export --------
# Xcode's IDEDistribution export forks an rsync *server* resolved via PATH;
# Homebrew rsync 3.4.2 rejects openrsync's flags → 'exportArchive Copy failed'.
# Prepending /usr/bin to PATH is NOT enough — the forked server ignores it.
for r in /opt/homebrew/bin/rsync /usr/local/bin/rsync; do
  if [ -e "$r" ]; then
    mv "$r" "$r.disabled" && RSYNC_MOVED="$r" && warn "moved $r aside for the build (restored on exit)"
    break
  fi
done

# --- stamp package.json version (reverted on exit) ------------------------------
PKG_BAK="$(mktemp)"
cp "$APP_DIR/package.json" "$PKG_BAK"
npm pkg set version="$APP_VERSION" >/dev/null

# openrsync first; homebrew still reachable for node/eas/fastlane.
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
export EAS_NO_VCS=1 EAS_SKIP_AUTO_FINGERPRINT=1

log "Shipping $APP_VERSION (profile: $EAS_PROFILE)"
echo "  ASC app=$ASC_APP_ID key=$ASC_KEY_ID issuer=${ASC_ISSUER_ID:0:8}… p8=$ASC_API_KEY_PATH"
[ -n "$ASC_APP_ID" ] || warn "ASC_APP_ID empty — submit/promote will fail. Set it or add submit.$EAS_PROFILE.ios.ascAppId to eas.json."

# --- BUILD ----------------------------------------------------------------------
log "eas build --local"
npx eas build --local --platform ios --profile "$EAS_PROFILE" --non-interactive --output ./build.ipa
BUILD_EXIT=$?
[ $BUILD_EXIT -eq 0 ] || die "build failed (exit $BUILD_EXIT). Check the last archive log; see references/local-build-recipe.md."

# --- SUBMIT ---------------------------------------------------------------------
log "eas submit"
npx eas submit --platform ios --profile "$EAS_PROFILE" --non-interactive --path ./build.ipa
SUBMIT_EXIT=$?
[ $SUBMIT_EXIT -eq 0 ] || die "submit failed (exit $SUBMIT_EXIT)."

# --- PROMOTE --------------------------------------------------------------------
PROMOTE_EXIT=0
if [ "${SKIP_PROMOTE:-}" = "1" ]; then
  warn "SKIP_PROMOTE=1 — not promoting to external review."
else
  log "promote to external review (build $APP_VERSION must reach VALID on ASC)"
  node "$SCRIPT_DIR/promote-external-review.mjs"
  PROMOTE_EXIT=$?
fi

log "Done — version=$APP_VERSION  BUILD_EXIT=$BUILD_EXIT SUBMIT_EXIT=$SUBMIT_EXIT PROMOTE_EXIT=$PROMOTE_EXIT"
echo "  Next: set feature notes with set-whatsnew.mjs, and (once) the demo account with set-beta-review-config.mjs."
exit $PROMOTE_EXIT
