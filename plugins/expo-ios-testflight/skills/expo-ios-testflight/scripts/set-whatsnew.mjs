#!/usr/bin/env node
/**
 * Set a feature-specific "what's new" (tester release notes) on the TestFlight
 * build EXPECTED_VERSION, replacing the generic note the promote step leaves.
 * Reuses the same ASC ES256-JWT auth as promote-external-review.mjs.
 *
 * Env:
 *   ASC_API_KEY_PATH  path to the .p8 (default: credentials/asc-api-key.p8)
 *   ASC_KEY_ID        App Store Connect API key id
 *   ASC_ISSUER_ID     App Store Connect issuer id
 *   ASC_APP_ID        the app's App Store Connect id
 *   EXPECTED_VERSION  the marketing version to annotate (REQUIRED)
 *   WHATS_NEW         the note text (REQUIRED)
 *   WHATS_NEW_LOCALE  which localization to patch/create (default en-US)
 */
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

const API = "https://api.appstoreconnect.apple.com";
const KEY_PATH = process.env.ASC_API_KEY_PATH || "credentials/asc-api-key.p8";
const KEY_ID = req("ASC_KEY_ID");
const ISSUER_ID = req("ASC_ISSUER_ID");
const APP_ID = req("ASC_APP_ID");
const WANT = req("EXPECTED_VERSION");
const WHATS_NEW = req("WHATS_NEW");
const LOCALE = process.env.WHATS_NEW_LOCALE || "en-US";

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

async function findBuild() {
  for (let i = 0; i < 20; i++) {
    const { json } = await api(
      "GET",
      `/v1/builds?filter[app]=${APP_ID}&limit=10&sort=-uploadedDate&include=preReleaseVersion`
    );
    const pre = {};
    for (const inc of json.included || [])
      if (inc.type === "preReleaseVersions") pre[inc.id] = inc.attributes.version;
    const match = (json.data || []).find(
      (b) => pre[(b.relationships.preReleaseVersion?.data || {}).id] === WANT
    );
    if (match) return match.id;
    console.log(`waiting for build ${WANT} to appear… (${i})`);
    await sleep(30_000);
  }
  throw new Error(`build ${WANT} not found`);
}

async function main() {
  const buildId = await findBuild();
  const { json } = await api("GET", `/v1/builds/${buildId}/betaBuildLocalizations`);
  const loc =
    (json.data || []).find((l) => l.attributes.locale === LOCALE) ||
    (json.data || [])[0];
  if (loc) {
    const r = await api("PATCH", `/v1/betaBuildLocalizations/${loc.id}`, {
      data: {
        type: "betaBuildLocalizations",
        id: loc.id,
        attributes: { whatsNew: WHATS_NEW },
      },
    });
    console.log(`patched ${loc.attributes.locale} whatsNew (${r.status})`);
  } else {
    const r = await api("POST", `/v1/betaBuildLocalizations`, {
      data: {
        type: "betaBuildLocalizations",
        attributes: { locale: LOCALE, whatsNew: WHATS_NEW },
        relationships: { build: { data: { type: "builds", id: buildId } } },
      },
    });
    console.log(`created ${LOCALE} whatsNew (${r.status})`);
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
