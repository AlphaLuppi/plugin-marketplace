---
name: expo-ios-testflight
description: Build an Expo / React Native iOS app locally on a Mac with `eas build --local` and ship it to TestFlight — submit to App Store Connect, then promote the exact build to the public external-testing group and set tester release notes. Use this skill when the user wants to cut an iOS TestFlight build/beta from an Expo app (locally to save EAS cloud credits, or to understand/repair the CI path), or hits the classic local-build failures: `spawn fastlane ENOENT`, `Provisioning profile doesn't include signing certificate`, or the Homebrew-rsync `exportArchive Copy failed`. Covers the App Store Connect JWT API (submit, external-review promotion, demo account for Beta App Review, `whatsNew` notes, submission rate-limit handling), marketing-version stamping, and the local↔CI split. Verify the change in a simulator first with the sibling `expo-ios-simulator-verify` skill.
---

# Expo iOS → TestFlight

Get an Expo / React Native iOS app onto TestFlight. Two paths, same outcome:

- **Local (this skill's focus)** — build the native `.ipa` on the Mac with `eas build --local` (no EAS cloud credits), then submit + promote via the App Store Connect API. Needs Xcode + a few machine-specific fixes (below).
- **CI (EAS cloud)** — a GitHub Actions workflow runs the heavy build on EAS servers. See `references/ci-vs-local.md`; the local path mirrors it step for step.

> The one real secret is the **App Store Connect API key (`.p8`)**. Everything else (key id, issuer id, app id) lives in the project's `eas.json` and is read from there or from env — never hardcode them, never commit the `.p8`.

## The pipeline (what "ship it" means)

```
stamp version → eas build --local (.ipa) → eas submit → promote to external review → set release notes
```

The bundled `scripts/testflight-ship.sh` runs the whole thing with the pitfall fixes applied. Read it before running — it `mv`s a Homebrew binary out of the way and edits `package.json` (both reverted on exit). Invoke:

```bash
cd <expo-app-dir>            # the dir with app.config.* + eas.json (e.g. apps/mobile)
ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_APP_ID=… \
  bash "${CLAUDE_PLUGIN_ROOT}/skills/expo-ios-testflight/scripts/testflight-ship.sh"
```

It reads `ASC_APP_ID` / `ASC_KEY_ID` / `ASC_ISSUER_ID` from env (or falls back to `eas.json` → `submit.production.ios`), so on a project like the one this was built for you can run it with **no args**. Run it in the background and watch the log — the full run is ~20 min build + ~5–15 min Apple processing before the external-review submit lands.

## Prerequisites (one-time per machine)

1. **Xcode** installed and its command-line tools selected (`xcodebuild -version`).
2. **EAS CLI + login**: `npx eas whoami` returns your Expo user. The project has an `eas.json` with a `production` build profile and `submit.production.ios` block.
3. **Linked EAS project**: `eas init` has been run so the app has an EAS project id (`extra.eas.projectId` in the app config / `EAS_PROJECT_ID`). `eas.json`'s `"appVersionSource": "remote"` + `"autoIncrement": true` store and increment the build number **on EAS servers**, so an unlinked project fails remote version resolution.
4. **fastlane** on `PATH`: `which fastlane`. Missing → `spawn fastlane ENOENT` during the archive. Fix: `brew install fastlane` (lands in `/opt/homebrew/bin`).
5. **App Store Connect API key**: a `.p8` at the path `eas.json` points to (`submit.production.ios.ascApiKeyPath`, e.g. `./credentials/asc-api-key.p8`), plus its key id, issuer id, and the app's ASC id. The `.p8` is git-ignored and provided out-of-band (base64 secret in CI). It grants submit + the review/promote API calls.
6. **A clean distribution certificate** (see pitfall 2). EAS manages its own signing cert for the app; a *stray* "Apple Distribution" cert in the login keychain can hijack auto-signing.

## The three local-build pitfalls (Mac only — clean CI runners don't hit these)

These are why a naïve `eas build --local` fails on a developer Mac. `testflight-ship.sh` handles all three; `references/local-build-recipe.md` has the full diagnosis for each.

| # | Symptom | Root cause | Fix |
|---|---------|-----------|-----|
| 1 | `spawn fastlane ENOENT` | fastlane not installed / not on PATH | `brew install fastlane`; keep `/opt/homebrew/bin` on PATH |
| 2 | `Provisioning profile doesn't include signing certificate` | a stray "Apple Distribution" cert in `login.keychain` wins auto-signing over the cert the EAS profile expects | delete the stray cert: `security delete-certificate -Z <SHA1> login.keychain-db` (user-confirmed; EAS has its own cert, so harmless for the app). macOS blocks non-interactive `.p12`/private-key export from the keychain, so no CLI backup is possible |
| 3 | `exportArchive Copy failed` / `rsync error … [server=3.4.2]` (a "session expired" line in the same log is a **false clue**) | Xcode's `IDEDistribution` export forks an rsync **server** resolved via PATH → hits Homebrew's rsync 3.4.2, which rejects openrsync's `--extended-attributes` flag | **move the Homebrew rsync symlink aside for the build** so `/usr/bin/rsync` (openrsync) is used on both ends: `mv /opt/homebrew/bin/rsync /opt/homebrew/bin/rsync.disabled` (restore in a `trap … EXIT`). **Prepending `/usr/bin` to PATH is NOT enough** — the forked rsync server ignores inherited PATH order. Diagnose from `IDEDistributionPipeline.log` in `$TMPDIR/<App>_<date>.xcdistributionlogs` |

Also seen: **`build.db is locked … concurrent builds`** — a previous `xcodebuild`/`expo run:ios` you thought you killed is still holding `DerivedData/…/XCBuildData/build.db`. Kill it: `pkill -f "<App>.xcworkspace"` + `kill -9 <pids>` before relaunching.

## Version stamping (must be monotonic and reach the build)

App Store Connect rejects a re-used `CFBundleShortVersionString` + build number. Convention that works with `eas.json`'s `"appVersionSource": "remote"` + `"autoIncrement": true`:

- **Marketing version** = `MAJOR.MINOR` from `package.json` + `PATCH` = `git rev-list --count HEAD` → e.g. `1.0.135`. Distinct and monotonic per commit.
- Write it into `package.json` (`npm pkg set version=…`) **and** export `APP_VERSION` so it reaches the build (an EAS build server / `EAS_NO_VCS=1` archive has no git history to recompute it). `testflight-ship.sh` does this and reverts `package.json` after.
- `autoIncrement: true` bumps the **build number** per build; you own the marketing version.

> **⚠️ Linchpin — your app config must resolve `version` from `APP_VERSION` / `package.json`.** `eas build` reads the marketing version from the **resolved Expo app config**, *not* from `package.json`. If your `app.json` / `app.config.*` has a **static** `version: "1.0.0"`, then `npm pkg set version` and `APP_VERSION` are both inert — every build ships as `1.0.0` and ASC rejects the duplicate. Convert the app to a dynamic `app.config.ts` whose `version` is computed. Reference resolver (generic — no project specifics):
>
> ```ts
> // app.config.ts — version resolves from APP_VERSION, then package.json,
> // then MAJOR.MINOR + git commit count for local dev.
> import { execSync } from "node:child_process";
> import { readFileSync } from "node:fs";
> import type { ExpoConfig } from "expo/config";
>
> function marketingVersion(): string {
>   // Priority 1: explicit override (what CI and testflight-ship.sh export).
>   if (process.env.APP_VERSION) return process.env.APP_VERSION;
>   let pkg = "1.0.0";
>   try { pkg = JSON.parse(readFileSync("./package.json", "utf8")).version ?? pkg; } catch {}
>   // Priority 2 (local dev only): MAJOR.MINOR from package.json + git commit
>   // count. Skipped in CI / on the EAS build server, which have no git history —
>   // there we trust the package.json the workflow already stamped (Priority 3).
>   if (!process.env.CI && !process.env.EAS_BUILD) {
>     try {
>       const count = execSync("git rev-list --count HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
>       const [maj = "1", min = "0"] = pkg.split(".");
>       if (/^\d+$/.test(count)) return `${maj}.${min}.${count}`;
>     } catch {}
>   }
>   return pkg;  // Priority 3: verbatim package.json (CI / EAS build server)
> }
>
> const config: ExpoConfig = { name: "MyApp", slug: "my-app", version: marketingVersion(), /* … */ };
> export default config;
> ```

## Environment for the build + ASC calls

```bash
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"   # openrsync first; homebrew still reachable for node/eas/fastlane
export APP_VERSION="1.0.<git-count>"                # reaches the build (see above)
export EAS_NO_VCS=1                                 # archive the working tree (stamped package.json), not git HEAD
export EAS_SKIP_AUTO_FINGERPRINT=1                  # skip fingerprint recompute on a dirty tree
# App Store Connect (from eas.json submit.production.ios, or env). The .p8 path too.
export ASC_APP_ID=…  ASC_KEY_ID=…  ASC_ISSUER_ID=…  ASC_API_KEY_PATH=./credentials/asc-api-key.p8
```

Build + submit commands (what the script runs):

```bash
npx eas build  --local --platform ios --profile production --non-interactive --output ./build.ipa
npx eas submit         --platform ios --profile production --non-interactive --path ./build.ipa
```

`--local` build uses **no EAS build credits** (it compiles on your Mac), and `eas submit` is an upload — it consumes **no build credits** either. So the whole local pipeline is free of EAS build usage; only a *cloud* `eas build` (the CI path) spends credits.

## Promote to external review + release notes (App Store Connect API)

`eas submit` uploads the build; it does **not** put it in front of external testers. Two more steps, both via the ASC REST API (ES256-JWT signed with the `.p8` — the auth helper is shared across the bundled `.mjs` scripts):

1. **Promote** — `scripts/promote-external-review.mjs`: waits for *your* build (matched by `EXPECTED_VERSION`) to reach `processingState: VALID`, attaches it to the app's public-link external group, ensures a "what to test" note exists, and submits it for **Beta App Review**. Idempotent (safe to re-run). Handles Apple's external-submission **rate limit** as a warning (the build is still on TestFlight; external review is merely deferred) rather than a hard failure.
2. **Demo account for review** (once per credentials change) — `scripts/set-beta-review-config.mjs`: sets the `betaAppReviewDetail` (demo login + contact + notes) so Apple's reviewer can sign in. If your app isolates reviewer data, the login here must match the account your backend seeds (see `references/appstoreconnect-api.md` → "Demo account & data isolation").
3. **Feature-specific release notes** — `scripts/set-whatsnew.mjs`: PATCH the build's `betaBuildLocalizations` `whatsNew` (e.g. `fr-FR`) to describe *this* build for testers, instead of the generic default the promote step leaves.

> **First-ship ordering.** On the **very first** external submission the demo
> account must already exist, or Apple's reviewer has no login. So on a fresh
> app run step 2 (`set-beta-review-config.mjs`) **before** step 1's Beta App
> Review submission. After that the `betaAppReviewDetail` persists app-level, so
> subsequent ships can promote first and only re-run the demo-account step when
> credentials change (the CI workflow in `references/ci-vs-local.md` runs it
> before the build for exactly this reason).

Full API reference — every endpoint, the JWT construction, all the edge cases, `DRY_RUN` — is in `references/appstoreconnect-api.md`.

## Before you build: verify in a simulator

A ~25-min build + Apple review is a slow feedback loop for a visual/interaction bug. Verify the change in a local iOS simulator **first** — use the sibling **`expo-ios-simulator-verify`** skill (it has the whole recipe, including the sandbox-input workarounds). TestFlight is the delivery step, not the test step.

## The SwiftUICore simulator caveat (only if the app uses `react-native-apple-llm`)

Apps embedding Apple Intelligence (`react-native-apple-llm` / FoundationModels) historically failed a **simulator** build with *"cannot link directly with 'SwiftUICore' … not an allowed client of it"* — while the **device**/Release build (and TestFlight) linked fine. On recent toolchains (Xcode 26.6 + iOS 26 simulator) this did **not** recur. So: it does not affect TestFlight; if a simulator build blocks on it, build on device or stub the module for simulator rather than abandoning local verification.

## Hand-off summary to give the user

After a run, report:
1. The marketing version built (e.g. `1.0.135`) and `BUILD_EXIT/SUBMIT_EXIT/PROMOTE_EXIT` (all 0 = success).
2. Build state on ASC: `VALID`, attached to the external group, and the public TestFlight link.
3. Beta App Review state (`WAITING_FOR_REVIEW`), or a rate-limit note if external review was deferred.
4. That `package.json` version and the rsync symlink were reverted (tree clean).
5. The release-notes locale/text set for testers.
6. Reminder: pushing `apps/mobile/**` to `main` may trigger the **cloud** CI build (EAS credits) unless the commit uses `[skip ci]` — see `references/ci-vs-local.md`.
