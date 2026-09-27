import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, loadConfig, writeCredentials } from "../src/config";
import { migrateLegacyStore, storePath } from "../src/store";

const dirs: string[] = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), "x-context-config-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const OAUTH_ENV = { X_API_KEY: "a", X_API_SECRET: "b", X_ACCESS_TOKEN: "c", X_ACCESS_TOKEN_SECRET: "d" };
const OAUTH_FILE = { api_key: "fa", api_secret: "fb", access_token: "fc", access_token_secret: "fd", username: "filed" };

describe("loadConfig", () => {
  test("uses complete env keys and ignores unsubstituted placeholders", () => {
    const dir = tempDir();
    const c = loadConfig({
      ...OAUTH_ENV,
      X_BEARER_TOKEN: "${user_config.x_bearer_token}",
      X_USERNAME: "@Tom",
      X_CONTEXT_DATA_DIR: dir,
    });
    expect(c.auth.kind).toBe("oauth1");
    expect(c.source).toBe("env");
    expect(c.username).toBe("Tom");
    expect(c.dataDir).toBe(dir);
    expect(c.problems).toEqual([]);
  });

  test("defaults the data dir to ~/.x-context, not the plugin data dir", () => {
    const c = loadConfig({ CLAUDE_PLUGIN_DATA: "/plugin/data" });
    expect(c.dataDir.endsWith(".x-context")).toBe(true);
  });

  test("falls back to the keys saved by x_connect, and says so when env is partial", () => {
    const dir = tempDir();
    writeCredentials(dir, OAUTH_FILE);
    const c = loadConfig({ X_API_KEY: "only-one", X_CONTEXT_DATA_DIR: dir });
    expect(c.source).toBe("file");
    expect(c.auth).toMatchObject({ kind: "oauth1", consumerKey: "fa", tokenSecret: "fd" });
    expect(c.username).toBe("filed");
    expect(c.problems.join(" ")).toContain("only have 1 of the 4");
    expect(c.problems.join(" ")).toContain("x_connect instead");
  });

  test("env keys win over saved keys", () => {
    const dir = tempDir();
    writeCredentials(dir, OAUTH_FILE);
    const c = loadConfig({ ...OAUTH_ENV, X_CONTEXT_DATA_DIR: dir });
    expect(c.source).toBe("env");
    expect(c.auth).toMatchObject({ consumerKey: "a" });
  });

  test("a bearer token needs a username, from env or file", () => {
    const dir = tempDir();
    expect(loadConfig({ X_BEARER_TOKEN: "t", X_CONTEXT_DATA_DIR: dir }).auth.kind).toBe("none");
    expect(loadConfig({ X_BEARER_TOKEN: "t", X_USERNAME: "tom", X_CONTEXT_DATA_DIR: dir }).auth.kind).toBe("bearer");
    writeCredentials(dir, { bearer_token: "ft", username: "tom" });
    expect(loadConfig({ X_CONTEXT_DATA_DIR: dir })).toMatchObject({ source: "file", auth: { kind: "bearer", token: "ft" } });
  });

  test("points to x_connect when nothing is configured", () => {
    const c = loadConfig({ X_CONTEXT_DATA_DIR: tempDir() });
    expect(c.auth.kind).toBe("none");
    expect(c.problems.at(-1)).toContain("x_connect");
  });

  test("a corrupt credentials file is treated as absent", () => {
    const dir = tempDir();
    writeFileSync(credentialsPath(dir), "{not json");
    expect(loadConfig({ X_CONTEXT_DATA_DIR: dir }).auth.kind).toBe("none");
  });

  test("writeCredentials writes an owner-only file", () => {
    const dir = tempDir();
    writeCredentials(dir, OAUTH_FILE);
    const saved = JSON.parse(readFileSync(credentialsPath(dir), "utf8"));
    expect(saved.api_key).toBe("fa");
    expect(saved.saved_at).toBeString();
    if (process.platform !== "win32") expect(statSync(credentialsPath(dir)).mode & 0o777).toBe(0o600);
  });
});

describe("migrateLegacyStore", () => {
  test("copies the v0.1 plugin-data cache once, never over an existing cache", async () => {
    const legacy = tempDir();
    const shared = join(tempDir(), "shared");
    writeFileSync(storePath(legacy), JSON.stringify({ version: 1, posts: { "1": {} } }));

    expect(await migrateLegacyStore(legacy, shared)).toBe(true);
    expect(JSON.parse(readFileSync(storePath(shared), "utf8")).posts).toHaveProperty("1");

    writeFileSync(storePath(legacy), JSON.stringify({ version: 1, posts: {} }));
    expect(await migrateLegacyStore(legacy, shared)).toBe(false);
    expect(JSON.parse(readFileSync(storePath(shared), "utf8")).posts).toHaveProperty("1");
  });

  test("is a no-op without a legacy dir or legacy cache", async () => {
    const shared = tempDir();
    expect(await migrateLegacyStore(undefined, shared)).toBe(false);
    const emptyLegacy = tempDir();
    mkdirSync(emptyLegacy, { recursive: true });
    expect(await migrateLegacyStore(emptyLegacy, shared)).toBe(false);
  });
});
