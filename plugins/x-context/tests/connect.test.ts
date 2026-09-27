import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath } from "../src/config";
import { esc, startConnectFlow, type ConnectFlow } from "../src/connect";
import { fakeX, ME } from "./fake-x";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

async function setup(opts: { rejectAuth?: boolean; ttlMs?: number } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), "x-context-connect-"));
  const x = fakeX([]);
  x.rejectAuth = opts.rejectAuth;
  const flow = await startConnectFlow({ dataDir, apiBase: "https://api.x.com", fetchImpl: x.fetch, ttlMs: opts.ttlMs });
  cleanups.push(() => {
    flow.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  return { dataDir, flow, x };
}

/** Raw HTTP so the test controls the Host and Origin headers like a browser (or an attacker) would. */
function call(
  flow: ConnectFlow,
  opts: { method?: string; path?: string; host?: string; origin?: string; body?: string } = {},
): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
  const url = new URL(flow.url);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: url.port,
        method: opts.method ?? "GET",
        path: opts.path ?? url.pathname,
        headers: {
          Host: opts.host ?? url.host,
          ...(opts.origin ? { Origin: opts.origin } : {}),
          ...(opts.body !== undefined
            ? { "Content-Type": "application/x-www-form-urlencoded", "Content-Length": Buffer.byteLength(opts.body) }
            : {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      },
    );
    req.on("error", reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

const OAUTH_FORM = new URLSearchParams({
  api_key: "ck",
  api_secret: "cs",
  access_token: "at",
  access_token_secret: "ats",
  username: "",
}).toString();

describe("x_connect page", () => {
  test("listens on 127.0.0.1 with an unguessable path and serves the form with strict headers", async () => {
    const { flow } = await setup();
    expect(flow.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/connect\/[\w-]{32}$/);
    const res = await call(flow);
    expect(res.status).toBe(200);
    expect(res.body).toContain('name="access_token_secret"');
    expect(res.body).toContain('type="password"');
    expect(res.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  test("rejects a wrong token, a foreign Host (DNS rebinding) and a foreign Origin", async () => {
    const { flow, dataDir } = await setup();
    expect((await call(flow, { path: "/connect/nope" })).status).toBe(404);
    expect((await call(flow, { host: "evil.example:80" })).status).toBe(421);
    const cross = await call(flow, { method: "POST", origin: "https://evil.example", body: OAUTH_FORM });
    expect(cross.status).toBe(403);
    expect(existsSync(credentialsPath(dataDir))).toBe(false);
  });

  test("verifies OAuth keys with X, saves them, confirms the account and closes", async () => {
    const { flow, dataDir, x } = await setup();
    const res = await call(flow, { method: "POST", origin: new URL(flow.url).origin, body: OAUTH_FORM });
    expect(res.status).toBe(200);
    expect(res.body).toContain(`@${ME.username}`);
    expect(res.body).not.toContain("ats");
    expect(x.calls[0]!.pathname).toBe("/2/users/me");
    const saved = JSON.parse(readFileSync(credentialsPath(dataDir), "utf8"));
    expect(saved).toMatchObject({ api_key: "ck", access_token_secret: "ats", username: ME.username });
    expect(saved.bearer_token).toBeUndefined();
    expect(await flow.done).toEqual(ME);
    expect(flow.isOpen()).toBe(false);
  });

  test("keys rejected by X are not saved and the form explains why", async () => {
    const { flow, dataDir } = await setup({ rejectAuth: true });
    const res = await call(flow, { method: "POST", body: OAUTH_FORM });
    expect(res.status).toBe(400);
    expect(res.body).toContain("X a refusé ces clés");
    expect(res.body).toContain("401");
    expect(existsSync(credentialsPath(dataDir))).toBe(false);
    expect(flow.isOpen()).toBe(true);
  });

  test("incomplete OAuth keys are refused before any API call", async () => {
    const { flow, x } = await setup();
    const res = await call(flow, { method: "POST", body: "api_key=ck&username=%3Cb%3Etom" });
    expect(res.status).toBe(400);
    expect(res.body).toContain("Il manque 3 des 4");
    expect(res.body).toContain("&#60;b&#62;tom");
    expect(x.calls).toHaveLength(0);
  });

  test("accepts a bearer token with a username", async () => {
    const { flow, dataDir, x } = await setup();
    const res = await call(flow, { method: "POST", body: "bearer_token=bt&username=%40tom" });
    expect(res.status).toBe(200);
    expect(x.calls[0]!.pathname).toBe("/2/users/by/username/tom");
    expect(JSON.parse(readFileSync(credentialsPath(dataDir), "utf8"))).toMatchObject({ bearer_token: "bt", username: "tom" });
  });

  test("oversized bodies are refused", async () => {
    const { flow } = await setup();
    const res = await call(flow, { method: "POST", body: `api_key=${"a".repeat(20_000)}` });
    expect(res.status).toBe(413);
    expect(flow.isOpen()).toBe(true);
  });

  test("expires on its own", async () => {
    const { flow } = await setup({ ttlMs: 50 });
    expect(await flow.done).toBeUndefined();
    expect(flow.isOpen()).toBe(false);
  });

  test("esc neutralises HTML", () => {
    expect(esc(`<a href="x">'&`)).toBe("&#60;a href=&#34;x&#34;&#62;&#39;&#38;");
  });
});
