import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildWritingContext, listPosts } from "./analytics";
import { loadConfig, type Config } from "./config";
import { renderList, renderSyncReport, renderWritingContext } from "./format";
import { loadStore, saveStore } from "./store";
import { runSync } from "./sync";
import { XClient } from "./x-client";

const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], isError });

export function createServer(config: Config = loadConfig(), fetchImpl: typeof fetch = fetch): McpServer {
  const server = new McpServer({ name: "x-context", version: "0.1.0" });
  const client = new XClient(config.auth, config.apiBase, fetchImpl);
  // Serialise syncs so two parallel calls can't clobber the cache file.
  let syncQueue: Promise<unknown> = Promise.resolve();

  server.registerTool(
    "x_sync",
    {
      title: "Sync my X posts",
      description:
        "Fetch my own X posts (and their engagement metrics) from the X API into the local cache. " +
        "Every post read is billed by X (~$0.001 with OAuth 1.0a keys, ~$0.005 with a bearer token), " +
        "so only new posts are fetched by default and `max_posts` caps the spend. Other tools read the " +
        "cache for free. Use `dry_run` to see the auth mode and the worst-case cost without calling the API. " +
        "Retweets are skipped. Read-only: never posts anything.",
      inputSchema: {
        mode: z
          .enum(["new", "backfill"])
          .default("new")
          .describe('"new" = posts newer than the cache (first run: the most recent ones). "backfill" = older posts, up to the ~3,200 the API exposes.'),
        max_posts: z.number().int().min(1).max(3200).default(200).describe("Maximum posts to read from the API in this call."),
        refresh_metrics_days: z
          .number()
          .int()
          .min(0)
          .max(90)
          .default(0)
          .describe("Also re-read posts from the last N days to update their metrics (≤29 adds owner-only metrics with OAuth 1.0a)."),
        dry_run: z.boolean().default(false),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, idempotentHint: false },
    },
    async ({ mode, max_posts, refresh_metrics_days, dry_run }) => {
      const run = syncQueue.then(async () => {
        const store = await loadStore(config.dataDir);
        const report = await runSync(client, store, config, {
          mode,
          maxPosts: max_posts,
          refreshMetricsDays: refresh_metrics_days,
          dryRun: dry_run,
        });
        if (!dry_run && (report.posts_read > 0 || store.user)) await saveStore(config.dataDir, store);
        return report;
      });
      syncQueue = run.catch(() => undefined);
      try {
        const report = await run;
        return text(renderSyncReport(report), Boolean(report.error) && report.posts_read === 0);
      } catch (err) {
        return text(`x_sync failed: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "x_writing_context",
    {
      title: "My X writing context",
      description:
        "The briefing to read before drafting a new X post: how I write (length, format, languages, cadence), " +
        "which formats / lengths / hours / weekdays perform best relative to my usual engagement, my top and " +
        "weakest posts with full text, and my most recent posts so the draft doesn't repeat them. Reads the " +
        "local cache only (free); says when the cache is stale.",
      inputSchema: {
        days: z.number().int().min(7).max(3650).default(365).describe("Analysis window in days."),
        top: z.number().int().min(0).max(50).default(12),
        bottom: z.number().int().min(0).max(20).default(4),
        recent: z.number().int().min(0).max(50).default(12),
        lang: z.string().optional().describe('Only posts in this language (BCP-47 code from X, e.g. "fr", "en").'),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ days, top, bottom, recent, lang }) => {
      try {
        const store = await loadStore(config.dataDir);
        const ctx = buildWritingContext(store, { days, top, bottom, recent, lang, timezone: config.timezone });
        const problems = store.last_sync_at ? [] : config.problems;
        return text([...problems.map((p) => `Config: ${p}`), renderWritingContext(ctx)].join("\n"));
      } catch (err) {
        return text(`x_writing_context failed: ${(err as Error).message}`, true);
      }
    },
  );

  server.registerTool(
    "x_list_posts",
    {
      title: "Search my X posts",
      description:
        "Filter, search and sort my cached X posts with full text and metrics. Use it to check whether I " +
        "already said something (query), to study a topic, or to pull more examples of a format. Free (cache only).",
      inputSchema: {
        query: z.string().optional().describe("Case-insensitive words that must all appear in the text."),
        kind: z
          .enum(["all", "original", "post", "quote", "thread", "reply"])
          .default("original")
          .describe('"original" = posts + quotes (thread openers included); "thread" = thread continuations.'),
        sort: z.enum(["recent", "engagement", "impressions", "engagement_rate", "outperformance"]).default("recent"),
        since: z.string().optional().describe("ISO date, inclusive."),
        until: z.string().optional().describe("ISO date, inclusive."),
        min_impressions: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(200).default(20),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, kind, sort, since, until, min_impressions, limit }) => {
      try {
        const store = await loadStore(config.dataDir);
        const items = listPosts(store, { query, kind, sort, since, until, minImpressions: min_impressions, limit });
        return text(
          renderList(items, {
            username: store.user?.username,
            timezone: config.timezone,
            lastSyncAt: store.last_sync_at,
            total: Object.keys(store.posts).length,
          }),
        );
      } catch (err) {
        return text(`x_list_posts failed: ${(err as Error).message}`, true);
      }
    },
  );

  return server;
}
