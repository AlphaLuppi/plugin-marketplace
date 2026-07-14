#!/usr/bin/env node
/**
 * Register the TestFlight *Beta App Review* demo account (+ contact info) in App
 * Store Connect, so the account Apple's reviewers use to test each build is
 * codified in the repo/CI instead of hand-edited in the ASC UI.
 *
 * If your app isolates reviewer data (a dedicated "review" account whose data
 * lives in an isolated bubble), the credentials set here MUST match the account
 * your backend seeds for that reviewer — drive both from the same secrets so the
 * reviewer logs into the isolated data set, not a real user's.
 *
 * The betaAppReviewDetail is app-level (one per app) and persists across builds,
 * so this only needs to run when the credentials change — but it's idempotent
 * and cheap, so a CI workflow can safely run it on every deploy.
 *
 * Env (auth — same as promote-external-review.mjs):
 *   ASC_API_KEY_PATH   path to the .p8 (default: credentials/asc-api-key.p8)
 *   ASC_KEY_ID         App Store Connect API key id
 *   ASC_ISSUER_ID      App Store Connect issuer id
 *   ASC_APP_ID         the app's App Store Connect id
 * Env (the demo account + review contact):
 *   TESTFLIGHT_DEMO_EMAIL        demo account login   (REQUIRED — no real default)
 *   TESTFLIGHT_DEMO_PASSWORD     demo account password (REQUIRED — no real default)
 *   TESTFLIGHT_DEMO_REQUIRED     "false" to mark the app as needing no login (default "true")
 *   TESTFLIGHT_CONTACT_EMAIL     review contact email (optional)
 *   TESTFLIGHT_CONTACT_FIRST_NAME / _LAST_NAME / _PHONE  (optional)
 *   TESTFLIGHT_REVIEW_NOTES      free-text notes for the reviewer (optional)
 *   DRY_RUN=1                    log the change without applying it
 *
 * SECURITY: never commit real demo credentials into this file or your repo —
 * pass them via env / CI secrets. The defaults below are obvious placeholders
 * that will NOT let a reviewer in; the script refuses to PATCH real values it
 * can't distinguish from the placeholder unless you set the env vars.
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.appstoreconnect.apple.com";
const KEY_PATH = process.env.ASC_API_KEY_PATH || "credentials/asc-api-key.p8";
const KEY_ID = req("ASC_KEY_ID");
const ISSUER_ID = req("ASC_ISSUER_ID");
const APP_ID = req("ASC_APP_ID");
const DRY_RUN = process.env.DRY_RUN === "1";

// Obvious placeholders — set the env vars to your real (isolated) review
// account. These defaults are here so the script self-documents its shape;
// they will not authenticate against any real backend.
const PLACEHOLDER_EMAIL = "review@example.com";
const PLACEHOLDER_PASSWORD = "CHANGE_ME_demo_password";

const DEMO_EMAIL = (
  process.env.TESTFLIGHT_DEMO_EMAIL?.trim() || PLACEHOLDER_EMAIL
).toLowerCase();
const DEMO_PASSWORD =
  process.env.TESTFLIGHT_DEMO_PASSWORD || PLACEHOLDER_PASSWORD;
const DEMO_REQUIRED = process.env.TESTFLIGHT_DEMO_REQUIRED !== "false";

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

/** The app has exactly one betaAppReviewDetail; fetch its id. */
async function betaReviewDetailId() {
  const { status, json } = await api(
    "GET",
    `/v1/apps/${APP_ID}/betaAppReviewDetail`
  );
  if (status >= 300 || !json.data) {
    throw new Error(
      `Could not read betaAppReviewDetail (${status}): ${JSON.stringify(
        json
      ).slice(0, 300)}`
    );
  }
  return json.data.id;
}

function buildAttributes() {
  const attrs = {
    demoAccountName: DEMO_EMAIL,
    demoAccountPassword: DEMO_PASSWORD,
    demoAccountRequired: DEMO_REQUIRED,
  };
  // Optional review-contact + notes: only send the ones provided so we never
  // clobber an existing value with an empty string.
  const optional = {
    contactEmail: process.env.TESTFLIGHT_CONTACT_EMAIL,
    contactFirstName: process.env.TESTFLIGHT_CONTACT_FIRST_NAME,
    contactLastName: process.env.TESTFLIGHT_CONTACT_LAST_NAME,
    contactPhone: process.env.TESTFLIGHT_CONTACT_PHONE,
    notes: process.env.TESTFLIGHT_REVIEW_NOTES,
  };
  for (const [k, v] of Object.entries(optional)) {
    if (v && v.trim()) attrs[k] = v.trim();
  }
  return attrs;
}

async function main() {
  console.log(`Set TestFlight beta review config${DRY_RUN ? " (DRY RUN)" : ""}`);

  // Guard: refuse to write the obvious placeholders to a real app, so a
  // misconfigured run can't silently register a dead login with Apple.
  if (DEMO_REQUIRED && DEMO_PASSWORD === PLACEHOLDER_PASSWORD) {
    console.error(
      "Refusing to set the placeholder demo password. Set TESTFLIGHT_DEMO_EMAIL " +
        "and TESTFLIGHT_DEMO_PASSWORD (or TESTFLIGHT_DEMO_REQUIRED=false if the " +
        "app needs no login)."
    );
    process.exit(1);
  }

  const id = await betaReviewDetailId();
  const attributes = buildAttributes();

  // Never print the password.
  const preview = { ...attributes, demoAccountPassword: "••••••" };
  console.log(`• demo account: ${DEMO_EMAIL} (required=${DEMO_REQUIRED})`);
  console.log(`• attributes: ${JSON.stringify(preview)}`);

  if (DRY_RUN) {
    console.log("• would PATCH betaAppReviewDetails");
    return;
  }

  const r = await api("PATCH", `/v1/betaAppReviewDetails/${id}`, {
    data: { type: "betaAppReviewDetails", id, attributes },
  });
  if (r.status >= 300) {
    const detail =
      r.json.errors?.[0]?.detail || JSON.stringify(r.json).slice(0, 300);
    throw new Error(`PATCH failed (${r.status}): ${detail}`);
  }
  console.log("✅ TestFlight demo account updated in App Store Connect");
}

main().catch((e) => {
  console.error("set-beta-review-config failed:", e.message);
  process.exit(1);
});
