# Local iOS build recipe — the three pitfalls in depth

`eas build --local --platform ios --profile production` runs the *same* build
EAS runs in the cloud, but on your machine. On a clean CI runner it just works;
on a developer Mac three environmental things bite. Each section below is the
full diagnosis so you can recognise it from the log and fix it, even outside the
bundled `testflight-ship.sh`.

The `--local` build has three internal phases, and the pitfalls map to them:

1. **Prebuild + CocoaPods** → JS/native project generated under the app dir.
2. **`RUN_FASTLANE`** → `fastlane gym` drives `xcodebuild archive` then
   `xcodebuild -exportArchive` to produce the signed `.ipa`. (Pitfalls 1–3 live here.)
3. **Upload** happens in the separate `eas submit` step, not the build.

---

## Pitfall 1 — `spawn fastlane ENOENT`

**Symptom.** The build reaches the `RUN_FASTLANE` phase and dies immediately:

```
Error: spawn fastlane ENOENT
```

**Cause.** `eas build --local` shells out to the `fastlane` binary for the
archive/export. Unlike the cloud image, a fresh Mac often doesn't have it.

**Fix.**

```bash
brew install fastlane          # lands in /opt/homebrew/bin/fastlane
which fastlane                 # confirm it's on PATH
```

Keep `/opt/homebrew/bin` on PATH for the build. (`testflight-ship.sh` reorders
PATH to put `/usr/bin` first for pitfall 3 but *appends* the original PATH, so
Homebrew's fastlane stays reachable.)

---

## Pitfall 2 — `Provisioning profile doesn't include signing certificate`

**Symptom.** During the archive/sign step:

```
error: Provisioning profile "..." doesn't include signing certificate
"Apple Distribution: … (TEAMID)".
```

…even though EAS provisioned its own distribution certificate for the app and
`eas credentials` shows it as valid.

**Cause.** A **stray "Apple Distribution" certificate** already sits in your
`login.keychain`. Xcode's automatic signing picks *it* (matching the team)
instead of the cert the EAS build's temporary keychain provides, and that stray
cert isn't in the provisioning profile → mismatch.

**Diagnosis.**

```bash
security find-identity -v -p codesigning login.keychain-db
# look for extra "Apple Distribution: <you> (TEAMID)" lines you don't recognise
```

**Fix — delete the stray cert (user-confirmed, destructive-ish but safe here).**

```bash
# SHA-1 comes from find-identity output above
security delete-certificate -Z <SHA1_HEX> login.keychain-db
```

Why it's safe: EAS manages its **own** distribution certificate for this app
inside a temporary build keychain, so removing the parasite from your login
keychain doesn't affect the app's signing — it just stops it hijacking
auto-signing. Confirm with the user before deleting any certificate.

> ⚠️ **No CLI backup is possible.** macOS blocks non-interactive export of a
> private key / `.p12` from the keychain (it forces a GUI auth prompt), so you
> cannot script a backup before deleting. If the user wants a backup, they must
> export it via Keychain Access.app themselves first. (This is about the signing
> identity in the keychain — not the App Store Connect `.p8`, which is a plain
> file on disk.)

---

## Pitfall 3 — `exportArchive Copy failed` / Homebrew rsync

**Symptom.** The **archive succeeds** ("Archive Succeeded") but the
**`-exportArchive`** step fails:

```
error: exportArchive: Copy failed
...
rsync: [server] ... unknown option --extended-attributes
rsync error: syntax or usage error (code 1) at ... [server=3.4.2]
```

You may also see a **`session expired`** line nearby — that is a **false clue**;
the real error is the rsync one.

**Cause.** Xcode's `IDEDistribution` export copies the built app using rsync, and
it forks an rsync **server** process resolved through `PATH`. Apple ships
**openrsync** at `/usr/bin/rsync`; the client side passes openrsync-specific
flags like `--extended-attributes`. If Homebrew's **rsync 3.4.2** (`/opt/homebrew/bin/rsync`)
wins the PATH lookup for the *server* side, it rejects those flags and the copy
dies.

**The trap: PATH reordering does NOT fix it.** Prepending `/usr/bin` to `PATH`
so `/usr/bin/rsync` comes first is not enough — the forked rsync *server* is
resolved in a context that ignores your inherited PATH order, so it still finds
the Homebrew one.

**Fix — move the Homebrew rsync symlink aside for the duration of the build:**

```bash
mv /opt/homebrew/bin/rsync /opt/homebrew/bin/rsync.disabled
#   ... run the build ...
mv /opt/homebrew/bin/rsync.disabled /opt/homebrew/bin/rsync   # restore
```

Do the restore in a `trap … EXIT` so a Ctrl-C or failure still puts it back
(`testflight-ship.sh` does exactly this). With the Homebrew one gone, both ends
resolve to `/usr/bin/rsync` (openrsync) and the flags match.

**Where to read the real error.** The `RUN_FASTLANE` phase truncates the export
error. The full log is in a per-run distribution-logs dir:

```bash
ls -dt "$TMPDIR"/*.xcdistributionlogs | head -1     # newest
# inside: IDEDistributionPipeline.log  ← the actual rsync failure
```

---

## Also seen — `build.db is locked … concurrent builds`

**Symptom.**

```
error: unable to attach DB: ... XCBuildData/build.db: database is locked
Ensure only one instance of Xcode / xcodebuild is building this project.
```

**Cause.** A previous `xcodebuild` (from an earlier `eas build --local` or
`expo run:ios`) is still alive holding the lock — killing the Expo/EAS wrapper
does not always kill the underlying `xcodebuild`.

**Fix.**

```bash
pkill -f "<App>.xcworkspace"           # e.g. MyApp.xcworkspace
# if that's not enough, find and hard-kill the survivors:
ps aux | grep -i xcodebuild | grep -v grep
kill -9 <pid> [<pid> …]
```

Then relaunch the build clean.

---

## Why CI doesn't hit these

The EAS cloud image (and a fresh GitHub macOS runner) has fastlane preinstalled,
no stray developer certs in its ephemeral keychain, and no Homebrew rsync
shadowing `/usr/bin/rsync`. That's why the CI path in
[`ci-vs-local.md`](./ci-vs-local.md) needs none of these fixes — they are
purely artefacts of a real developer Mac.
