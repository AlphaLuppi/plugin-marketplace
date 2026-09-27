import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeX, makePost } from "./fake-x";

// Runs the bundled server exactly as Claude Code does (node + stdio), against a
// local stand-in for api.x.com. Requires `bun run build` first.
const bundle = join(import.meta.dir, "..", "dist", "server.mjs");
const dataDir = mkdtempSync(join(tmpdir(), "x-context-e2e-"));
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
    client = new Client({ name: "e2e", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: "node",
        args: [bundle],
        env: {
          PATH: process.env.PATH ?? "",
          X_API_BASE_URL: `http://localhost:${http.port}`,
          X_API_KEY: "ck",
          X_API_SECRET: "cs",
          X_ACCESS_TOKEN: "at",
          X_ACCESS_TOKEN_SECRET: "ats",
          X_BEARER_TOKEN: "${user_config.x_bearer_token}",
          X_CONTEXT_DATA_DIR: dataDir,
          X_TIMEZONE: "Europe/Paris",
        },
      }),
    );
  });

  afterAll(async () => {
    await client?.close();
    http?.stop(true);
    rmSync(dataDir, { recursive: true, force: true });
  });

  test("lists the three tools with read-only hints on the cache readers", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["x_list_posts", "x_sync", "x_writing_context"]);
    expect(tools.find((t) => t.name === "x_writing_context")!.annotations?.readOnlyHint).toBe(true);
  });

  test("x_sync fetches through signed OAuth 1.0a requests and persists the cache", async () => {
    const res = await client.callTool({ name: "x_sync", arguments: {} });
    const out = textOf(res);
    expect(res.isError).toBeFalsy();
    expect(out).toContain("Sync done for @tom");
    expect(out).toContain("40 new");
    expect(out).toContain("$0.040");
    expect(authHeaders.every((h) => h.startsWith("OAuth ") && h.includes("oauth_signature="))).toBe(true);
    const saved = JSON.parse(readFileSync(join(dataDir, "posts.json"), "utf8"));
    expect(Object.keys(saved.posts)).toHaveLength(40);
  });

  test("x_writing_context and x_list_posts read the cache", async () => {
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
