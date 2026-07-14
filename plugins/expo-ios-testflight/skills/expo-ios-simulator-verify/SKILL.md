---
name: expo-ios-simulator-verify
description: Verify an Expo / React Native change in a local iOS simulator BEFORE cutting a TestFlight build — build with `expo run:ios`, launch/screenshot the target screen with `xcrun simctl`, and confirm the render/interaction visually. Use this skill whenever a mobile UI or interaction change needs checking and you'd otherwise wait ~25 min for a TestFlight build to see it on device. Critically, covers what to do when host-driven input automation is unavailable — MobAI/idb absent and `osascript`/`cliclick` blocked by macOS Accessibility (error -1719) — via revertable `__DEV__`-only render hacks plus `simctl` screenshots, the multi-simulator `booted`-ambiguity trap, the `EXPO_PUBLIC_*` Metro-inlining trap, the `build.db is locked` concurrent-build trap, and the SwiftUICore simulator link caveat for apps using Apple Intelligence.
---

# Verify an Expo iOS change in the simulator (before TestFlight)

A TestFlight build is ~25 min + Apple processing. For a visual or interaction
change that's a terrible feedback loop. Build to a **local iOS simulator**
first, confirm the screen renders and behaves, *then* ship with the sibling
`expo-ios-testflight` skill. TestFlight is the delivery step, not the test step.

The catch on a sandboxed / headless-ish Mac: you often **cannot drive taps and
typing** from the host (see Step 4). The reliable workaround is to make the app
show you what you need via small **`__DEV__`-only** code hacks, screenshot with
`xcrun simctl`, then revert every hack. This skill is that whole recipe.

## Step 1 — Build & launch on a simulator

```bash
cd <expo-app-dir>
# EXPO_PUBLIC_* vars are inlined by Metro at BUNDLE time — pass the real API URL
# or the app talks to its placeholder default and reaches no backend.
EXPO_PUBLIC_API_URL=https://your-backend.example.com \
  npx expo run:ios --device "<UDID>"
```

- **Target the device by explicit UDID**, not "booted" (Step 3 trap).
- List simulators / UDIDs: `xcrun simctl list devices available`.
- First build is slow (native compile); subsequent JS-only changes hot-reload
  via Metro without a rebuild.

## Step 2 — Screenshot the screen

```bash
xcrun simctl io <UDID> screenshot /tmp/shot.png
# launch / relaunch the app by bundle id if needed:
xcrun simctl launch <UDID> <bundle.id>
xcrun simctl terminate <UDID> <bundle.id>
```

Read the PNG back to confirm the render. The bundled
`scripts/sim-shot.sh <UDID> <out.png>` wraps this and picks the sole booted
device when you omit the UDID (erroring if the choice is ambiguous — Step 3).

## Step 3 — The traps (each cost real time to diagnose)

| Trap | Symptom | Fix |
|------|---------|-----|
| **`booted` ambiguity** | Two+ booted simulators → `simctl … booted` hits the wrong one; you screenshot a home screen instead of your app | Target an explicit **UDID** everywhere; `xcrun simctl shutdown <other-UDID>` the strays |
| **`EXPO_PUBLIC_*` not inlined** | App hits a placeholder host / no backend data | Set the var **on the `expo run:ios` command** — Metro inlines it at bundle time, not runtime |
| **`build.db is locked`** | `XCBuildData/build.db: database is locked … only one instance` | A prior `xcodebuild`/`expo run:ios` survived; `pkill -f "<App>.xcworkspace"` + `kill -9 <pids>`, then rebuild |
| **SwiftUICore link error** | *"cannot link directly with 'SwiftUICore' … not an allowed client"* — **simulator only**, if the app uses `react-native-apple-llm`/FoundationModels | Historically simulator-only (device/Release links fine); did **not** recur on Xcode 26.6 + iOS 26. If it blocks you, verify on a physical device or stub the module for simulator |

## Step 4 — When host input automation is blocked (the important part)

On a sandboxed Mac you will likely find **every host-driven input path closed**:

- **MobAI MCP** — bridge down / unavailable.
- **`idb`** (Facebook's iOS Device Bridge) — not installed, and installing it
  isn't reliable here.
- **`osascript` / `cliclick`** (synthetic events) — blocked by the macOS
  **Accessibility** permission: they fail with **`-1719` (assistive access)**,
  which cannot be granted without a GUI click the sandbox can't make.
- **`xcrun simctl openurl` with a custom scheme** — pops a non-clickable
  "Open in <App>?" dialog that then sticks (needs a simulator reboot to clear).

So you can **see** (screenshots) but not **touch**. The workaround is to drive
the app from *inside* with `__DEV__`-gated code, then revert. Patterns that
worked (all wrapped in `if (__DEV__)`):

1. **Auto-login** in your auth context with a known dev/demo account, so
   screenshots aren't stuck on the login screen.
2. **Force the target screen**: many RN nav setups don't switch tabs reliably
   via `initialRouteName`/`openurl`, so `if (__DEV__) return <TargetScreen/>` at
   the top of the default tab is the dependable way to land on it.
3. **Pre-apply the interaction you'd have tapped**: e.g. auto-select the first
   graph edge, force a section `defaultOpen`, so the post-tap state is visible in
   a screenshot without a tap.
4. **Scroll programmatically**: a `ScrollView` `ref` + `scrollTo` in an effect
   *after* the data loads — `contentOffset` set at mount is clamped because the
   content isn't tall enough yet.

**Then revert everything.** Remove all `__DEV__` hacks, re-check `git diff`, and
re-run typecheck + lint before committing. The hacks are a viewing aid, never
part of the change. Full rationale, exact snippets, and the reasoning behind each
trap → `references/tooling-workarounds.md`.

## Step 5 — Confirm, then hand off to the build

Confirm from the screenshots that the changed screen renders and the
interaction's resulting state is correct. Only then proceed to
`expo-ios-testflight` to build and ship. Report to the user: which screens you
verified, at what simulator/OS version, that all `__DEV__` hacks were reverted
(tree clean), and any trap you hit so it's on record for next time.
