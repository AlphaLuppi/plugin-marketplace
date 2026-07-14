# App Store Connect API reference (TestFlight)

`eas submit` uploads the `.ipa`. Everything after that — putting the build in
front of external testers, the reviewer's demo account, and tester release
notes — is done through the **App Store Connect REST API**
(`https://api.appstoreconnect.apple.com`). The three bundled `.mjs` scripts each
do one slice; this doc is the full map so you can debug or extend them.

## Authentication — ES256 JWT from the `.p8`

Every request carries `Authorization: Bearer <jwt>`. The JWT is signed with the
App Store Connect API key (`.p8`, an EC P-256 private key) using **ES256**:

```js
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

function token() {
  const pk = readFileSync(process.env.ASC_API_KEY_PATH, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header  = b64({ alg: "ES256", kid: process.env.ASC_KEY_ID, typ: "JWT" });
  const payload = b64({
    iss: process.env.ASC_ISSUER_ID,
    iat: now,
    exp: now + 900,              // ≤ 20 min; 15 min is safe
    aud: "appstoreconnect-v1",
  });
  const sig = createSign("SHA256")
    .update(`${header}.${payload}`)
    // CRITICAL: raw r||s signature, not DER. Node calls this "ieee-p1363".
    .sign({ key: pk, dsaEncoding: "ieee-p1363" }, "base64url");
  return `${header}.${payload}.${sig}`;
}
```

**Gotchas that cause a silent `401`:**
- `dsaEncoding: "ieee-p1363"` is mandatory. The Node default is DER, which Apple
  rejects. This is the single most common reason a hand-rolled ASC JWT fails.
- `aud` must be exactly `"appstoreconnect-v1"`.
- `exp` must be ≤ 20 minutes from `iat`. Mint a fresh token per call (the scripts
  call `token()` on every request) rather than reusing one across a long poll.
- `kid` = the **key id** (e.g. from the key's filename `AuthKey_XXXX.p8`), `iss`
  = the **issuer id** (a UUID, one per team, shown at the top of Users and
  Access → Integrations → App Store Connect API).

The key needs the **App Manager** role (or a role that grants TestFlight write)
to do the promote/submit calls.

## The identifiers (not secrets — keep them in `eas.json`)

| Value | Where it lives | Env var used by scripts |
|-------|---------------|-------------------------|
| Key id | `submit.<profile>.ios.ascApiKeyId` | `ASC_KEY_ID` |
| Issuer id | `submit.<profile>.ios.ascApiKeyIssuerId` | `ASC_ISSUER_ID` |
| App (ASC) id | `submit.<profile>.ios.ascAppId` | `ASC_APP_ID` |
| `.p8` path | `submit.<profile>.ios.ascApiKeyPath` | `ASC_API_KEY_PATH` |

Only the **`.p8` file** is a credential. Git-ignore it; in CI restore it from a
base64 secret. `testflight-ship.sh` reads all four from `eas.json` when the env
vars aren't set.

## Endpoint map

### Find the build you just uploaded

```
GET /v1/builds?filter[app]={APP_ID}&limit=10&sort=-uploadedDate&include=preReleaseVersion
```

- Match your build by marketing version: join `data[].relationships.preReleaseVersion`
  to the `included[]` `preReleaseVersions` entry and compare `.attributes.version`
  to `EXPECTED_VERSION`. **Always match by version** — grabbing the newest build
  blindly can promote a concurrent or older build.
- `attributes.processingState` cycles `PROCESSING → VALID` (or `FAILED` /
  `INVALID`). Only a `VALID` build can be attached/submitted. Apple processing
  after upload typically takes ~5–15 min; poll every 60 s
  (`promote-external-review.mjs` waits up to `PROMOTE_TIMEOUT_MIN`, default 25).

### The external (public-link) group

```
GET /v1/betaGroups?filter[app]={APP_ID}&limit=100
```

Pick the group with `isInternalGroup === false && publicLinkEnabled === true` —
that's the one whose `attributes.publicLink` (`testflight.apple.com/join/…`) you
share. Internal groups don't need Beta App Review; external ones do.

### Attach a build to the group

```
POST /v1/betaGroups/{GROUP_ID}/relationships/builds
{ "data": [ { "type": "builds", "id": "{BUILD_ID}" } ] }
```

Idempotence: first `GET /v1/betaGroups/{GROUP_ID}/relationships/builds` and skip
if the build id is already listed.

### Tester release notes (`whatsNew`) — required for external testing

```
GET  /v1/builds/{BUILD_ID}/betaBuildLocalizations
POST /v1/betaBuildLocalizations
     { "data": { "type": "betaBuildLocalizations",
                 "attributes": { "locale": "en-US", "whatsNew": "…" },
                 "relationships": { "build": { "data": { "type": "builds", "id": "{BUILD_ID}" } } } } }
PATCH /v1/betaBuildLocalizations/{LOC_ID}
     { "data": { "type": "betaBuildLocalizations", "id": "{LOC_ID}",
                 "attributes": { "whatsNew": "…" } } }
```

External review is rejected if there's **no** build localization. The promote
script creates a generic one; `set-whatsnew.mjs` overwrites it per-build with the
real feature note (POST if the locale doesn't exist yet, else PATCH).

### Submit for Beta App Review

```
GET  /v1/builds/{BUILD_ID}/betaAppReviewSubmission   → current state or null
POST /v1/betaAppReviewSubmissions
     { "data": { "type": "betaAppReviewSubmissions",
                 "relationships": { "build": { "data": { "type": "builds", "id": "{BUILD_ID}" } } } } }
```

`betaReviewState` runs `WAITING_FOR_REVIEW → IN_REVIEW → APPROVED` (or
`REJECTED`). Skip the POST if already in one of the first three
(`promote-external-review.mjs` guards on this so re-runs are safe).

**The external-submission rate limit.** Apple caps how many builds you can send
to *external* review in a rolling window. Over the cap, the POST returns **HTTP
422** with a detail like "You've reached the maximum number of builds you can
submit". This is **not fatal**: the build is already uploaded and attached to the
public group (internal testers can install immediately), only the external review
is deferred until the window resets. `promote-external-review.mjs` treats a 422
matching `/submission limit|rate ?limit|too many/i` as a **warning** and exits 0;
genuine errors still throw. Re-run later, or submit manually in the ASC UI.

### Demo account & data isolation (Beta App Review detail)

```
GET   /v1/apps/{APP_ID}/betaAppReviewDetail          → the single detail's id
PATCH /v1/betaAppReviewDetails/{DETAIL_ID}
      { "data": { "type": "betaAppReviewDetails", "id": "{DETAIL_ID}",
                  "attributes": {
                    "demoAccountName": "…", "demoAccountPassword": "…",
                    "demoAccountRequired": true,
                    "contactEmail": "…", "contactFirstName": "…",
                    "contactLastName": "…", "contactPhone": "…", "notes": "…"
                  } } }
```

- `betaAppReviewDetail` is **app-level** (one per app) and persists across
  builds, so `set-beta-review-config.mjs` only needs to run when the credentials
  change (running it every deploy is harmless — the PATCH is idempotent).
- **Data isolation**: if your app gives Apple's reviewer a *dedicated* account
  whose data lives in an isolated bubble (so a reviewer poking around can't see
  or mutate real users' data), the `demoAccountName` / `demoAccountPassword` set
  here **must** match the account your backend seeds for the reviewer. Drive both
  from the same secret. A drift between the two = the reviewer can't log in =
  rejected build. Never hardcode the real password in the script or repo — pass
  it via env / CI secret (the bundled script defaults to an obvious placeholder
  and *refuses* to PATCH the placeholder to a real app).
- **The create-only-seed trap (this bites in practice).** If your backend seeds
  the reviewer account idempotently with a *create-if-not-exists / early-return*
  pattern, it **never updates the password of an account that already exists**.
  So the day you rotate the demo password in App Store Connect, the backend DB
  keeps the old hash → the reviewer gets a 401 → the build is rejected, with no
  obvious cause. Make the seed **refresh** the reviewer's password on every run
  (upsert the password, don't skip when the row exists) so ASC and the backend
  self-heal into agreement each deploy.
- Only send optional contact fields you actually have — sending an empty string
  clobbers an existing value.

## DRY_RUN

`promote-external-review.mjs` and `set-beta-review-config.mjs` honour `DRY_RUN=1`:
they do all the reads and log exactly what they *would* POST/PATCH without
mutating App Store Connect. Use it to validate auth + the resolved build/group
before a real run.

## Quick auth smoke test

```bash
ASC_API_KEY_PATH=… ASC_KEY_ID=… ASC_ISSUER_ID=… ASC_APP_ID=… \
node -e '
  import("node:crypto").then(async ({createSign})=>{
    const fs=await import("node:fs");
    const now=Math.floor(Date.now()/1000);
    const b64=o=>Buffer.from(JSON.stringify(o)).toString("base64url");
    const h=b64({alg:"ES256",kid:process.env.ASC_KEY_ID,typ:"JWT"});
    const p=b64({iss:process.env.ASC_ISSUER_ID,iat:now,exp:now+900,aud:"appstoreconnect-v1"});
    const s=createSign("SHA256").update(h+"."+p).sign({key:fs.readFileSync(process.env.ASC_API_KEY_PATH,"utf8"),dsaEncoding:"ieee-p1363"},"base64url");
    const r=await fetch(`https://api.appstoreconnect.apple.com/v1/builds?filter[app]=${process.env.ASC_APP_ID}&limit=1`,{headers:{Authorization:`Bearer ${h}.${p}.${s}`}});
    console.log(r.status, (await r.text()).slice(0,200));
  });'
# 200 = auth good. 401 = JWT wrong (check dsaEncoding / aud / exp / ids).
```
