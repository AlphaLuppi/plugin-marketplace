import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Auth =
  | {
      kind: "oauth1";
      consumerKey: string;
      consumerSecret: string;
      token: string;
      tokenSecret: string;
    }
  | { kind: "bearer"; token: string }
  | { kind: "none" };

export interface Config {
  auth: Auth;
  /** Where the credentials came from: the host's settings (env) or the x_connect page (file). */
  source: "env" | "file" | "none";
  username?: string;
  dataDir: string;
  apiBase: string;
  timezone: string;
  /** Human-readable configuration issues, surfaced by tools instead of crashing. */
  problems: string[];
}

/** Shape of `<dataDir>/credentials.json`, written by x_connect. */
export interface StoredCredentials {
  api_key?: string;
  api_secret?: string;
  access_token?: string;
  access_token_secret?: string;
  bearer_token?: string;
  username?: string;
  saved_at?: string;
}

/**
 * Hosts substitute `${user_config.KEY}` into the MCP env. An option left empty
 * may arrive as "" or, depending on the host, as the raw placeholder. Both mean "unset".
 */
export function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || /^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

/**
 * Shared by every surface (Claude Code plugin, Cowork, Claude Desktop extension)
 * so a post is paid for once and the keys are entered once.
 */
export function defaultDataDir(): string {
  return join(homedir(), ".x-context");
}

export function credentialsPath(dataDir: string): string {
  return join(dataDir, "credentials.json");
}

export function readCredentials(dataDir: string): StoredCredentials | undefined {
  try {
    return JSON.parse(readFileSync(credentialsPath(dataDir), "utf8")) as StoredCredentials;
  } catch {
    return undefined;
  }
}

/** Owner-only file (0600 on POSIX; on Windows the user profile ACL applies). */
export function writeCredentials(dataDir: string, creds: StoredCredentials): void {
  mkdirSync(dataDir, { recursive: true });
  const target = credentialsPath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...creds, saved_at: new Date().toISOString() }, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(tmp, target);
  try {
    chmodSync(target, 0o600);
  } catch {
    // Not supported on every filesystem; the directory lives in the user's home anyway.
  }
}

interface Candidate {
  oauth: [string | undefined, string | undefined, string | undefined, string | undefined];
  bearer?: string;
  username?: string;
}

function toAuth(c: Candidate): Auth | undefined {
  const [consumerKey, consumerSecret, token, tokenSecret] = c.oauth;
  if (consumerKey && consumerSecret && token && tokenSecret) {
    return { kind: "oauth1", consumerKey, consumerSecret, token, tokenSecret };
  }
  if (c.bearer && c.username) return { kind: "bearer", token: c.bearer };
  return undefined;
}

const OAUTH1_VARS = ["X_API_KEY", "X_API_SECRET", "X_ACCESS_TOKEN", "X_ACCESS_TOKEN_SECRET"] as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];
  const dataDir = clean(env.X_CONTEXT_DATA_DIR) ?? defaultDataDir();

  const fromEnv: Candidate = {
    oauth: OAUTH1_VARS.map((name) => clean(env[name])) as Candidate["oauth"],
    bearer: clean(env.X_BEARER_TOKEN),
    username: clean(env.X_USERNAME)?.replace(/^@/, ""),
  };
  const file = readCredentials(dataDir);
  const fromFile: Candidate = {
    oauth: [clean(file?.api_key), clean(file?.api_secret), clean(file?.access_token), clean(file?.access_token_secret)],
    bearer: clean(file?.bearer_token),
    username: clean(file?.username)?.replace(/^@/, ""),
  };

  let auth: Auth = { kind: "none" };
  let source: Config["source"] = "none";
  const envAuth = toAuth(fromEnv);
  const fileAuth = toAuth({ ...fromFile, username: fromFile.username ?? fromEnv.username });
  if (envAuth) {
    auth = envAuth;
    source = "env";
  } else if (fileAuth) {
    auth = fileAuth;
    source = "file";
  }

  const envOAuthSet = fromEnv.oauth.filter(Boolean).length;
  if (envOAuthSet > 0 && envOAuthSet < 4) {
    const missing = OAUTH1_VARS.filter((_, i) => !fromEnv.oauth[i]);
    problems.push(
      `The host settings only have ${envOAuthSet} of the 4 OAuth 1.0a keys (missing ${missing.join(", ")})` +
        (source === "file" ? "; using the keys saved with x_connect instead." : "."),
    );
  }
  if (auth.kind === "none") {
    if (fromEnv.bearer && !fromEnv.username) {
      problems.push("A bearer token needs X_USERNAME (your @handle) to know whose posts to read.");
    }
    problems.push(
      "No usable X credentials. Call the x_connect tool: it opens a local page where the user enters " +
        "their X API keys (they never go through the conversation). They can also be set in the plugin " +
        "or extension settings.",
    );
  }

  return {
    auth,
    source,
    username: fromEnv.username ?? fromFile.username,
    dataDir,
    apiBase: (clean(env.X_API_BASE_URL) ?? "https://api.x.com").replace(/\/+$/, ""),
    timezone: clean(env.X_TIMEZONE) ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    problems,
  };
}

/** USD per post read, per the X pay-per-use price list (Sept 2026). */
export function costPerPost(auth: Auth): number {
  return auth.kind === "oauth1" ? 0.001 : 0.005;
}
