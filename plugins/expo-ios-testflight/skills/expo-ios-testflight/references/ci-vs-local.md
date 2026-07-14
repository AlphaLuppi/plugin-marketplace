# CI (EAS cloud) vs. local build — same pipeline, two runners

The local recipe and the CI workflow do the **same five steps**; they differ
only in *where the native build runs* and which environment quirks apply.

| Step | Local (`testflight-ship.sh`) | CI (GitHub Actions + EAS cloud) |
|------|------------------------------|----------------------------------|
| Native build | `eas build --local` on your Mac (no EAS credits) | `eas build` on EAS servers (uses EAS build credits) |
| Runner | your Mac (Xcode required) | lightweight `ubuntu-latest` (no Xcode — EAS builds remotely) |
| Pitfalls 1–3 | **apply** (fastlane, cert, rsync) | **don't apply** (clean ephemeral image) |
| Version stamp | `npm pkg set version` + `APP_VERSION` | same, in a workflow step |
| `.p8` key | already on disk (git-ignored) | restored from a base64 secret at runtime |
| Submit | `eas submit` | `eas build --auto-submit-with-profile` |
| Promote | `promote-external-review.mjs` | same script, as a workflow step |

**Trade-off.** Local trades your machine's ~20 min + Xcode setup for **zero EAS
credits**; CI trades credits for a hands-off push-to-ship on a clean runner that
never hits the three Mac pitfalls. Same artefact, same TestFlight result.

## The CI cross-trigger to know about

If your repo has a workflow that builds on push to `main` touching the mobile
app path, then **merging mobile changes to `main` triggers a cloud build (EAS
credits) even when you already shipped the same code locally.** To build locally
*instead of* CI, put `[skip ci]` in the merge commit (or scope the workflow's
`paths:` so the local-only change doesn't match).

## Reference workflow (generic — fill in your own secrets)

A working `ubuntu-latest` workflow. **The identifiers below are placeholders** —
put your key id / issuer id / app id in `eas.json` (or repo *variables*) and the
`.p8` in a secret. Never commit the `.p8` or a real demo password.

```yaml
name: Mobile → TestFlight

on:
  push:
    branches: [main]
    paths:
      - "apps/mobile/**"
      - ".github/workflows/mobile-testflight.yml"
  workflow_dispatch: {}

concurrency:
  group: mobile-testflight
  cancel-in-progress: false

jobs:
  build-and-submit:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    defaults:
      run:
        working-directory: apps/mobile
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0            # full history → accurate commit-count version

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
          cache-dependency-path: apps/mobile/package-lock.json

      - uses: expo/expo-github-action@v8
        with:
          eas-version: latest
          token: ${{ secrets.EXPO_TOKEN }}   # expo.dev → Account → Access tokens

      - run: npm ci

      - name: Stamp marketing version
        run: |
          BASE=$(node -p "require('./package.json').version.split('.').slice(0,2).join('.')")
          COUNT=$(git rev-list --count HEAD)
          VERSION="$BASE.$COUNT"
          npm pkg set version="$VERSION"
          echo "APP_VERSION=$VERSION" >> "$GITHUB_ENV"

      - name: Restore App Store Connect API key
        run: |
          mkdir -p credentials
          printf '%s' "${{ secrets.ASC_API_KEY_P8 }}" | base64 --decode > credentials/asc-api-key.p8
          test -s credentials/asc-api-key.p8 || { echo "::error::ASC_API_KEY_P8 is empty"; exit 1; }

      - name: Sync TestFlight demo account (Beta App Review)
        env:
          ASC_API_KEY_PATH: credentials/asc-api-key.p8
          ASC_KEY_ID:    ${{ vars.ASC_KEY_ID }}       # e.g. AAAA0000BB
          ASC_ISSUER_ID: ${{ vars.ASC_ISSUER_ID }}    # a UUID
          ASC_APP_ID:    ${{ vars.ASC_APP_ID }}       # the numeric app id
          TESTFLIGHT_DEMO_EMAIL:    ${{ secrets.TESTFLIGHT_DEMO_EMAIL }}
          TESTFLIGHT_DEMO_PASSWORD: ${{ secrets.TESTFLIGHT_DEMO_PASSWORD }}
          TESTFLIGHT_REVIEW_NOTES: "Demo account provided (isolated test data). All features accessible after sign-in."
        run: node scripts/set-beta-review-config.mjs

      - name: Build on EAS and upload to TestFlight
        env:
          EAS_NO_VCS: "1"           # archive the working tree (stamped package.json)
        run: |
          eas build \
            --platform ios \
            --profile production \
            --non-interactive \
            --message "${GITHUB_SHA::7}" \
            --auto-submit-with-profile production

      - name: Promote to external TestFlight review
        env:
          ASC_API_KEY_PATH: credentials/asc-api-key.p8
          ASC_KEY_ID:    ${{ vars.ASC_KEY_ID }}
          ASC_ISSUER_ID: ${{ vars.ASC_ISSUER_ID }}
          ASC_APP_ID:    ${{ vars.ASC_APP_ID }}
          PROMOTE_TIMEOUT_MIN: "25"
          EXPECTED_VERSION: ${{ env.APP_VERSION }}    # promote exactly this run's build
        run: node scripts/promote-external-review.mjs

      - name: Cleanup
        if: always()
        run: rm -f credentials/asc-api-key.p8
```

### Required secrets / variables

| Name | Kind | What |
|------|------|------|
| `EXPO_TOKEN` | secret | Expo access token (expo.dev → Account → Access tokens) |
| `ASC_API_KEY_P8` | secret | **base64** of the App Store Connect `.p8` (`base64 -i key.p8 \| pbcopy`) |
| `TESTFLIGHT_DEMO_EMAIL` / `_PASSWORD` | secret | reviewer demo login (must match your backend's isolated review account) |
| `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_APP_ID` | variable | not secret — could equally live in `eas.json` |

The `.p8` is the only true credential. Everything else is an identifier; keeping
the ids in repo *variables* (or `eas.json`) rather than secrets is fine and makes
the local and CI paths read from the same source.

## Why `EAS_NO_VCS=1`

Both paths stamp the version into `package.json`, then set `EAS_NO_VCS=1` so EAS
archives the **working tree** (with the stamped `package.json`) instead of the
committed `git HEAD`. Without it, EAS would archive the clean HEAD and the version
bump wouldn't reach the build. Locally, `testflight-ship.sh` also sets
`EAS_SKIP_AUTO_FINGERPRINT=1` so a dirty tree doesn't trigger a fingerprint
recompute.

> This only works if your **app config resolves `version` from `APP_VERSION` /
> `package.json`** — a static `version: "1.0.0"` in `app.json`/`app.config`
> makes the stamp inert and every build ships as `1.0.0`. See the "Linchpin"
> callout in the main `expo-ios-testflight` SKILL for the reference
> `marketingVersion()` resolver.
