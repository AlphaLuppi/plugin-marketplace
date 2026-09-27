import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeX, makePost } from "./fake-x";

// Runs the bundled server exactly as a host does (node + stdio), with no keys in
// its env — the Claude Desktop / Cowork situation — against a local stand-in for
// api.x.com. Requires `bun run build` first.
const bundle = join(import.meta.dir, "..", "dist", "server.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "x-context-e2e-"));
const legacyDir = mkdtempSync(join(tmpdir(), "x-context-e2e-legacy-"));
const x = fakeX(Array.from({ length: 40 }, (_, i) => makePost(i + 1, { text: i === 7 ? "Shipping the plugin today" : `post ${i + 1}` })));
const authHeaders: string[] = [];
let http: ReturnType<typeof Bun.serve>;
let client: Client;

const textOf = (res: Awaited<ReturnType<Client["callTool"]>>) =>
  (res.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe.skipIf(!existsSync(bundle))("bundled MCP server over stdio", () => {
  beforeAll(async () => {
    http = Bun.serve({
      port: 0,
      fetch: (req) => {
        authHeaders.push(req.headers.get("authorization") ?? "");
        return x.fetch(req);
      },
    });
    // A v0.1 cache left in the plugin data dir must be picked up, not re-bought.
    const legacyPost = makePost(1, { text: "bought in v0.1" });
    writeFileSync(
      join(legacyDir, "posts.json"),
      JSON.stringify({
        version: 1,
        posts: {
          [legacyPost.id]: {
            id: legacyPost.id,
            text: legacyPost.text,
            created_at: legacyPost.created_at,
            kind: "post",
            metrics: { likes: 1, reposts: 0, replies: 0, quotes: 0, bookmarks: 0, impressions: 10 },
            has_media: false,
            has_poll: false,
            has_link: false,
            hashtags: [],
            is_long: false,
            first_seen_at: legacyPost.created_at,
            metrics_updated_at: legacyPost.created_at,
          },
        },
        gaps: [],
        reached_timeline_start: false,
        spend: [],
      }),
    );
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [bundle],
        env: {
          PATH: process.env.PATH ?? "",
          X_API_BASE_URL: `http://localhost:${http.port}`,
          // What an unconfigured host passes: empty values and raw placeholders.
          X_API_KEY: "",
          X_ACCESS_TOKEN: "${user_config.x_access_token}",
          X_CONTEXT_DATA_DIR: dataDir,
          CLAUDE_PLUGIN_DATA: legacyDir,
          X_TIMEZONE: "Europe/Paris",
        },
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
    http?.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(legacyDir, { recursive: true, force: true });
  });

  test("lists the four tools with read-only hints on the cache readers", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["x_connect", "x_list_posts", "x_sync", "x_writing_context"]);
    expect(tools.find((t) => t.name === "x_writing_context")!.annotations?.readOnlyHint).toBe(true);
  });

  test("without keys, x_sync points to x_connect and the legacy cache is already visible", async () => {
    const res = await client.callTool({ name: "x_sync", arguments: { dry_run: true } });
    const out = textOf(res);
    expect(out).toContain("auth: none");
    expect(out).toContain("x_connect");
    expect(out).toContain("Cache: 1 posts");
  });

  test("x_connect serves a page whose form saves verified keys, then x_sync uses them", async () => {
    const res = await client.callTool({ name: "x_connect", arguments: { open_browser: false } });
    const url = textOf(res).match(/http:\/\/127\.0\.0\.1:\d+\/connect\/[\w-]+/)?.[0];
    expect(url).toBeDefined();

    const again = textOf(await client.callTool({ name: "x_connect", arguments: { open_browser: false } }));
    expect(again).toContain(url!);

    const form = new URLSearchParams({ api_key: "ck", api_secret: "cs", access_token: "at", access_token_secret: "ats" });
    const submit = await fetch(url!, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(url!).origin },
      body: form,
    });
    expect(submit.status).toBe(200);
    expect(await submit.text()).toContain("@tom");
    expect(JSON.parse(readFileSync(join(dataDir, "credentials.json"), "utf8")).username).toBe("tom");

    const sync = textOf(await client.callTool({ name: "x_sync", arguments: {} }));
    expect(sync).toContain("Sync done for @tom");
    expect(sync).toContain("via keys saved by x_connect");
    // Post 1 came with the migrated cache: only the 39 newer ones are bought.
    expect(sync).toContain("39 new");
    expect(sync).toContain("$0.039");
    expect(authHeaders.every((h) => h.startsWith("OAuth ") && h.includes("oauth_signature="))).toBe(true);
  });

  test("x_writing_context and x_list_posts read the shared cache", async () => {
    const ctx = textOf(await client.callTool({ name: "x_writing_context", arguments: { days: 3650 } }));
    expect(ctx).toContain("# Writing context for @tom");
    expect(ctx).toContain("## Most recent posts");

    const hits = textOf(await client.callTool({ name: "x_list_posts", arguments: { query: "shipping plugin" } }));
    expect(hits).toContain("> Shipping the plugin today");
    expect(hits).toContain("1 of 40 cached posts");
  });

  test("invalid arguments are rejected by the schema", async () => {
    const res = await client.callTool({ name: "x_sync", arguments: { max_posts: 99999 } });
    expect(res.isError).toBe(true);
  });
});
