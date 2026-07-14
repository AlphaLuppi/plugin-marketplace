# expo-ios-testflight

Ship an **Expo / React Native** iOS app to **TestFlight** — build it locally on
a Mac (no EAS cloud credits) or via CI, submit it, and promote the exact build to
the public external-testing group. Plus a battle-tested recipe for verifying a
change in the **iOS simulator** before you build.

Distilled from real, painful iterations shipping an Expo app to TestFlight: the
developer-Mac build pitfalls, the App Store Connect API dance, and what to do
when you can't drive the simulator from the host.

## What's inside

Two skills:

### `expo-ios-testflight` — build & ship
The local build pipeline `build → submit → promote`, with the three
developer-Mac pitfalls encoded and fixed:
- `spawn fastlane ENOENT` → install fastlane
- `Provisioning profile doesn't include signing certificate` → remove the stray
  distribution cert
- `exportArchive Copy failed` (Homebrew rsync 3.4.2 vs openrsync) → move the
  Homebrew rsync aside for the build (PATH reordering is **not** enough)

…plus marketing-version stamping, the App Store Connect JWT API (submit,
external-review promotion, reviewer demo account, `whatsNew` notes, and Apple's
external-submission rate limit), and the local↔CI split.

**Scripts** (`skills/expo-ios-testflight/scripts/`):
- `testflight-ship.sh` — the whole pipeline with all pitfall fixes + safe cleanup
- `promote-external-review.mjs` — attach to public group + submit for Beta App Review (idempotent, rate-limit-aware)
- `set-beta-review-config.mjs` — set the reviewer demo account / contact
- `set-whatsnew.mjs` — set per-build tester release notes

**References**: `local-build-recipe.md` (each pitfall in depth),
`appstoreconnect-api.md` (every endpoint + JWT gotchas), `ci-vs-local.md` (a
generic GitHub Actions workflow).

### `expo-ios-simulator-verify` — check before you build
Build with `expo run:ios`, screenshot with `xcrun simctl`, and — crucially — how
to verify a change when host input automation is unavailable (MobAI/idb absent,
`osascript`/`cliclick` blocked by macOS Accessibility `-1719`): revertable
`__DEV__`-only render hacks + screenshots. Covers the multi-simulator `booted`
trap, the `EXPO_PUBLIC_*` Metro-inlining trap, `build.db is locked`, and the
SwiftUICore simulator link caveat.

**Script**: `sim-shot.sh` (screenshot the right simulator, erroring on ambiguity).

## Install

```bash
/plugin marketplace add AlphaLuppi/plugin-marketplace
/plugin install expo-ios-testflight@alphaluppi-plugins
```

## Configure (per project)

The only real credential is the **App Store Connect API key (`.p8`)**. Keep it
git-ignored; in CI restore it from a base64 secret. Everything else is an
identifier — put it in your project's `eas.json` under `submit.<profile>.ios`:

```jsonc
{
  "submit": {
    "production": {
      "ios": {
        "ascApiKeyPath": "./credentials/asc-api-key.p8",
        "ascApiKeyId": "<your key id>",
        "ascApiKeyIssuerId": "<your issuer uuid>",
        "ascAppId": "<your numeric app id>"
      }
    }
  }
}
```

`testflight-ship.sh` reads these from `eas.json` (env vars override). No secret
values are baked into any script — the demo-account script defaults to an obvious
placeholder and refuses to register it against a real app.

## Run

```bash
cd apps/mobile        # your Expo app dir (has eas.json)
bash "${CLAUDE_PLUGIN_ROOT}/skills/expo-ios-testflight/scripts/testflight-ship.sh"
```

## License

MIT
