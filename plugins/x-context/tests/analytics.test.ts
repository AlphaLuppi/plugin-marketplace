import { describe, expect, test } from "bun:test";
import { buildWritingContext, listPosts, median, outperformance } from "../src/analytics";
import { renderList, renderSyncReport, renderWritingContext } from "../src/format";
import { emptyStore, mergePosts, normalizePost, reclassify, type StoredPost } from "../src/store";
import { makePost, ME } from "./fake-x";

const DAY = 86_400_000;
const NOW = new Date(Date.UTC(2026, 5, 30));

/** 60 original posts, one every 2 days, metrics captured a week after publishing. */
function seededStore() {
  const store = emptyStore();
  store.user = ME;
  store.last_sync_at = NOW.toISOString();
  const posts: StoredPost[] = [];
  for (let i = 1; i <= 60; i++) {
    const created = new Date(NOW.getTime() - (120 - 2 * i) * DAY);
    const raw = makePost(i, {
      created_at: created.toISOString(),
      text: i % 10 === 0 ? `Big idea ${i}?\nSecond line with detail` : `routine update ${i}`,
      public_metrics: {
        like_count: i % 10 === 0 ? 500 : 20,
        repost_count: 2,
        reply_count: 3,
        quote_count: 0,
        bookmark_count: i % 10 === 0 ? 50 : 1,
        impression_count: i % 10 === 0 ? 20_000 : 1_500,
      },
    });
    const post = normalizePost(raw, new Date(created.getTime() + 7 * DAY).toISOString());
    posts.push(post);
  }
  mergePosts(store, posts);
  return store;
}

describe("normalizePost", () => {
  const now = NOW.toISOString();

  test("classifies replies, quotes and long posts from either API naming", () => {
    const reply = normalizePost(makePost(1, { conversation_id: "123" }), now);
    expect(reply.kind).toBe("reply");

    const quote = normalizePost(
      makePost(2, { entities: { urls: [{ expanded_url: "https://x.com/someone/status/99" }] } }),
      now,
    );
    expect(quote.kind).toBe("quote");
    expect(quote.has_link).toBe(false);

    const legacyQuote = normalizePost(makePost(3, { referenced_tweets: [{ type: "quoted", id: "9" }] }), now);
    expect(legacyQuote.kind).toBe("quote");

    const long = normalizePost(makePost(4, { note_post: { text: "x".repeat(600) } }), now);
    expect(long.is_long).toBe(true);
    expect(long.text).toHaveLength(600);

    const legacyMetrics = normalizePost(makePost(5, { public_metrics: { retweet_count: 7 } }), now);
    expect(legacyMetrics.metrics.reposts).toBe(7);
  });

  test("detects links and media, ignoring photo permalinks", () => {
    const p = normalizePost(
      makePost(1, {
        entities: {
          urls: [
            { expanded_url: "https://x.com/tom/status/1/photo/1" },
            { expanded_url: "https://tomandrieu.com/blog" },
          ],
          hashtags: [{ tag: "buildinpublic" }],
        },
        attachments: { media_keys: ["3_1"] },
      }),
      now,
    );
    expect(p.has_link).toBe(true);
    expect(p.has_media).toBe(true);
    expect(p.hashtags).toEqual(["buildinpublic"]);
  });

  test("reclassify turns replies inside my own conversations into thread posts", () => {
    const store = emptyStore();
    store.user = ME;
    const root = normalizePost(makePost(1), now);
    const continuation = normalizePost(makePost(2, { conversation_id: root.id }), now);
    const replyToOther = normalizePost(makePost(3, { conversation_id: "777" }), now);
    mergePosts(store, [root, continuation, replyToOther]);
    reclassify(store);
    expect(store.posts[continuation.id]!.kind).toBe("thread");
    expect(store.posts[replyToOther.id]!.kind).toBe("reply");
  });
});

describe("analytics", () => {
  test("median", () => {
    expect(median([])).toBe(0);
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });

  test("outperformance ranks standout posts well above 1 and routine posts near 1", () => {
    const store = seededStore();
    const scores = outperformance(Object.values(store.posts));
    const standout = Object.values(store.posts).find((p) => p.text.startsWith("Big idea 30"))!;
    const routine = Object.values(store.posts).find((p) => p.text === "routine update 31")!;
    expect(scores.get(standout.id)!).toBeGreaterThan(10);
    expect(scores.get(routine.id)!).toBeCloseTo(1, 0);
  });

  test("outperformance skips posts whose metrics were captured too early", () => {
    const fresh = normalizePost(makePost(1), makePost(1).created_at!);
    expect(outperformance([fresh]).has(fresh.id)).toBe(false);
  });

  test("writing context surfaces top posts, breakdowns, voice and recent posts", () => {
    const ctx = buildWritingContext(seededStore(), {
      days: 365,
      top: 3,
      bottom: 2,
      recent: 5,
      timezone: "Europe/Paris",
      now: NOW,
    });
    expect(ctx.top).toHaveLength(3);
    expect(ctx.top.every((t) => t.post.text.startsWith("Big idea"))).toBe(true);
    expect(ctx.bottom).toHaveLength(2);
    expect(ctx.recent[0]!.post.text).toBe("Big idea 60?\nSecond line with detail");
    expect(ctx.voice.n).toBe(60);
    expect(ctx.voice.pct_question).toBe(10);
    expect(ctx.breakdowns.length!.map((b) => b.label)).toEqual(["≤100 chars"]);
    expect(ctx.breakdowns.weekday!.length).toBeGreaterThan(0);

    const md = renderWritingContext(ctx, NOW.getTime());
    expect(md).toContain("# Writing context for @tom");
    expect(md).toContain("## Top posts");
    expect(md).toContain("> Big idea 60?");
    expect(md).toContain("> Second line with detail");
    expect(md).toContain("https://x.com/tom/status/");
    expect(md).not.toContain("stale");
  });

  test("writing context on an empty cache tells the agent to sync", () => {
    const ctx = buildWritingContext(emptyStore(), { days: 365, top: 5, bottom: 0, recent: 5, timezone: "UTC", now: NOW });
    const md = renderWritingContext(ctx, NOW.getTime());
    expect(md).toContain("Never synced");
    expect(md).toContain("No original posts");
  });

  test("listPosts filters by words, kind and date, and sorts", () => {
    const store = seededStore();
    const hits = listPosts(store, { kind: "original", query: "BIG second", sort: "engagement", limit: 50, minImpressions: 0 });
    expect(hits).toHaveLength(6);
    const since = listPosts(store, {
      kind: "all",
      sort: "recent",
      limit: 100,
      minImpressions: 0,
      since: new Date(NOW.getTime() - 10 * DAY).toISOString(),
    });
    expect(since.length).toBeGreaterThan(0);
    expect(since.length).toBeLessThan(10);
    const byViews = listPosts(store, { kind: "all", sort: "impressions", limit: 1, minImpressions: 10_000 });
    expect(byViews[0]!.post.metrics.impressions).toBe(20_000);

    const text = renderList(byViews, { username: "tom", timezone: "UTC", lastSyncAt: undefined, total: 60 });
    expect(text).toContain("1 of 60 cached posts");
  });

  test("sync report rendering mentions cost and errors", () => {
    const out = renderSyncReport({
      user: "@tom",
      auth: "oauth1",
      source: "env",
      mode: "new",
      dry_run: false,
      posts_read: 12,
      added: 10,
      updated: 2,
      est_cost_usd: 0.012,
      total_cached: 110,
      gaps_remaining: 0,
      reached_timeline_start: false,
      warnings: [],
      error: "X API 402: No credits",
    });
    expect(out).toContain("$0.012");
    expect(out).toContain("Error: X API 402");
  });
});
