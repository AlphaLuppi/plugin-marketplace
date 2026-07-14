#!/usr/bin/env node
/**
 * Promote the latest processed iOS build to external TestFlight review, so the
 * public link (testflight.apple.com/join/…) updates automatically.
 *
 * Idempotent: attaches the newest VALID build to the external (public-link)
 * group, ensures a "what to test" note, and submits it for Beta App Review —
 * skipping any step already done. The demo account + review contact are stored
 * app-level in App Store Connect and persist across builds, so no secrets live
 * here.
 *
 * Env:
 *   ASC_API_KEY_PATH  path to the .p8 (default: credentials/asc-api-key.p8)
 *   ASC_KEY_ID        App Store Connect API key id
 *   ASC_ISSUER_ID     App Store Connect issuer id
 *   ASC_APP_ID        the app's App Store Connect id
 *   EXPECTED_VERSION  the marketing version this run built (match the right build)
 *   BETA_NOTE_LOCALE  locale for the default "what to test" note (default en-US)
 *   BETA_NOTE_TEXT    the default note text (override the generic placeholder)
 *   PROMOTE_TIMEOUT_MIN   how long to wait for a VALID build (default 25)
 *   DRY_RUN=1         log actions without attaching/submitting
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.appstoreconnect.apple.com";
const KEY_PATH = process.env.ASC_API_KEY_PATH || "credentials/asc-api-key.p8";
const KEY_ID = req("ASC_KEY_ID");
const ISSUER_ID = req("ASC_ISSUER_ID");
const APP_ID = req("ASC_APP_ID");
const TIMEOUT_MIN = Number(process.env.PROMOTE_TIMEOUT_MIN || 25);
const DRY_RUN = process.env.DRY_RUN === "1";
const NOTE_LOCALE = process.env.BETA_NOTE_LOCALE || "en-US";
const NOTE_TEXT =
  process.env.BETA_NOTE_TEXT ||
  "New build. Please test and report anything that looks off.";

function req(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env ${name}`);
    process.exit(1);
  }
  return v;
}

function token() {
  const pk = readFileSync(KEY_PATH, "utf8");
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = b64({ alg: "ES256", kid: KEY_ID, typ: "JWT" });
  const payload = b64({
    iss: ISSUER_ID,
    iat: now,
    exp: now + 900,
    aud: "appstoreconnect-v1",
  });
  const sig = createSign("SHA256")
    .update(`${header}.${payload}`)
    .sign({ key: pk, dsaEncoding: "ieee-p1363" })
    .toString("base64url");
  return `${header}.${payload}.${sig}`;
}

async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      Authorization: `Bearer ${token()}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The build to promote. When EXPECTED_VERSION is set (the marketing version
 * this run built), wait for *that* build to appear and be VALID — otherwise a
 * concurrent/older already-VALID build could be promoted by mistake. Without
 * it, fall back to the newest VALID build.
 */
async function waitForValidBuild() {
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  const want = process.env.EXPECTED_VERSION;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await api(
      "GET",
      `/v1/builds?filter[app]=${APP_ID}&limit=10&sort=-uploadedDate&include=preReleaseVersion`
    );
    const pre = {};
    for (const inc of json.included || []) {
      if (inc.type === "preReleaseVersions") pre[inc.id] = inc.attributes.version;
    }
    const builds = (json.data || []).map((b) => ({
      b,
      version: pre[(b.relationships.preReleaseVersion?.data || {}).id],
      state: b.attributes.processingState,
    }));

    // The candidate: the matching-version build, or the newest one.
    const candidate = want
      ? builds.find((x) => x.version === want)
      : builds[0];

    if (candidate) {
      last = candidate;
      console.log(
        `build ${candidate.version ?? "?"} (${candidate.b.id}) — ${candidate.state}`
      );
      if (candidate.state === "VALID") return candidate.b;
      if (candidate.state === "FAILED" || candidate.state === "INVALID") {
        throw new Error(`Build ${candidate.version} is ${candidate.state}`);
      }
    } else {
      console.log(
        want ? `waiting for build ${want} to appear…` : "no build uploaded yet…"
      );
    }
    await sleep(60_000);
  }
  throw new Error(
    `Timed out after ${TIMEOUT_MIN} min waiting for a VALID build` +
      (want ? ` matching ${want}` : "") +
      (last ? ` (last: ${last.version} ${last.state})` : "")
  );
}

/** The external beta group that owns the public link. */
async function externalPublicGroup() {
  const { json } = await api(
    "GET",
    `/v1/betaGroups?filter[app]=${APP_ID}&limit=100`
  );
  const g = (json.data || []).find(
    (x) => !x.attributes.isInternalGroup && x.attributes.publicLinkEnabled
  );
  if (!g) throw new Error("No external group with a public link found");
  return g;
}

async function isBuildInGroup(groupId, buildId) {
  const { json } = await api("GET", `/v1/betaGroups/${groupId}/relationships/builds`);
  return (json.data || []).some((b) => b.id === buildId);
}

async function hasBuildLocalization(buildId) {
  const { json } = await api(
    "GET",
    `/v1/builds/${buildId}/betaBuildLocalizations`
  );
  return (json.data || []).length > 0;
}

async function reviewState(buildId) {
  const { json } = await api(
    "GET",
    `/v1/builds/${buildId}/betaAppReviewSubmission`
  );
  return json.data ? json.data.attributes.betaReviewState : null;
}

async function main() {
  console.log(`Promote to external review${DRY_RUN ? " (DRY RUN)" : ""}`);
  const build = await waitForValidBuild();
  const group = await externalPublicGroup();
  console.log(
    `External group: ${group.attributes.name} — ${group.attributes.publicLink}`
  );

  // 1. Attach to the public group.
  if (await isBuildInGroup(group.id, build.id)) {
    console.log("• already in the public group");
  } else if (DRY_RUN) {
    console.log("• would attach build to the public group");
  } else {
    const r = await api(
      "POST",
      `/v1/betaGroups/${group.id}/relationships/builds`,
      { data: [{ type: "builds", id: build.id }] }
    );
    console.log(`• attached to public group (${r.status})`);
  }

  // 2. Ensure a "what to test" note (required for external testing).
  if (await hasBuildLocalization(build.id)) {
    console.log("• build notes already set");
  } else if (DRY_RUN) {
    console.log("• would add build notes");
  } else {
    const r = await api("POST", `/v1/betaBuildLocalizations`, {
      data: {
        type: "betaBuildLocalizations",
        attributes: {
          locale: NOTE_LOCALE,
          whatsNew: NOTE_TEXT,
        },
        relationships: { build: { data: { type: "builds", id: build.id } } },
      },
    });
    console.log(`• build notes added (${r.status})`);
  }

  // 3. Submit for Beta App Review (skip if already in/through review).
  const state = await reviewState(build.id);
  const done = ["WAITING_FOR_REVIEW", "IN_REVIEW", "APPROVED"];
  if (state && done.includes(state)) {
    console.log(`• already submitted for review (state=${state})`);
  } else if (DRY_RUN) {
    console.log("• would submit for Beta App Review");
  } else {
    const r = await api("POST", `/v1/betaAppReviewSubmissions`, {
      data: {
        type: "betaAppReviewSubmissions",
        relationships: { build: { data: { type: "builds", id: build.id } } },
      },
    });
    if (r.status < 300) {
      console.log(
        `✅ submitted for Beta App Review (state=${r.json.data.attributes.betaReviewState})`
      );
    } else {
      const err = r.json.errors?.[0];
      const detail =
        err?.detail || JSON.stringify(r.json).slice(0, 300);
      // Apple caps how many builds can be submitted for EXTERNAL review in a
      // window. Hitting that limit is transient: the build is already uploaded
      // and attached to the public group, so it's on TestFlight — the external
      // review is merely deferred until the limit resets. Don't red the whole
      // pipeline for an Apple rate limit (genuine errors still throw).
      const rateLimited =
        r.status === 422 && /submission limit|rate ?limit|too many/i.test(detail);
      if (rateLimited) {
        console.warn(
          `⚠︎ external review not submitted (${r.status}): ${detail}\n` +
            "  Build is on TestFlight (internal testers can install now); external " +
            "review will need a later re-run or a manual submit in App Store Connect."
        );
      } else {
        throw new Error(`Review submission failed (${r.status}): ${detail}`);
      }
    }
  }
  console.log("Done.");
}

main().catch((e) => {
  console.error("promote failed:", e.message);
  process.exit(1);
});
