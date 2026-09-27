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
  username?: string;
  dataDir: string;
  apiBase: string;
  timezone: string;
  /** Human-readable configuration issues, surfaced by tools instead of crashing. */
  problems: string[];
}

/**
 * Claude Code substitutes `${user_config.KEY}` into the MCP env. An option the
 * user left empty may arrive as "" or, depending on the version, as the raw
 * placeholder. Both mean "unset".
 */
export function clean(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "" || /^\$\{[^}]*\}$/.test(trimmed)) return undefined;
  return trimmed;
}

const OAUTH1_VARS = {
  consumerKey: "X_API_KEY",
  consumerSecret: "X_API_SECRET",
  token: "X_ACCESS_TOKEN",
  tokenSecret: "X_ACCESS_TOKEN_SECRET",
} as const;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const problems: string[] = [];

  const oauth = Object.fromEntries(
    Object.entries(OAUTH1_VARS).map(([field, name]) => [field, clean(env[name])]),
  ) as Record<keyof typeof OAUTH1_VARS, string | undefined>;
  const oauthSet = Object.values(oauth).filter(Boolean).length;
  const bearer = clean(env.X_BEARER_TOKEN);
  const username = clean(env.X_USERNAME)?.replace(/^@/, "");

  let auth: Auth = { kind: "none" };
  if (oauthSet === 4) {
    auth = {
      kind: "oauth1",
      consumerKey: oauth.consumerKey!,
      consumerSecret: oauth.consumerSecret!,
      token: oauth.token!,
      tokenSecret: oauth.tokenSecret!,
    };
  } else {
    if (oauthSet > 0) {
      const missing = Object.entries(OAUTH1_VARS)
        .filter(([field]) => !oauth[field as keyof typeof OAUTH1_VARS])
        .map(([, name]) => name);
      problems.push(
        `OAuth 1.0a is partially configured (missing ${missing.join(", ")}). ` +
          (bearer ? "Falling back to the bearer token." : "Provide all four keys or a bearer token."),
      );
    }
    if (bearer) {
      auth = { kind: "bearer", token: bearer };
      if (!username) {
        problems.push("A bearer token needs X_USERNAME (your @handle) to know whose posts to read.");
      }
    }
  }
  if (auth.kind === "none" && oauthSet === 0) {
    problems.push(
      "No X credentials configured. Set the four OAuth 1.0a keys (recommended: owned reads cost " +
        "$0.001/post instead of $0.005) or a bearer token + username in the plugin settings.",
    );
  }

  const dataDir =
    clean(env.X_CONTEXT_DATA_DIR) ?? clean(env.CLAUDE_PLUGIN_DATA) ?? join(homedir(), ".x-context");

  return {
    auth,
    username,
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
