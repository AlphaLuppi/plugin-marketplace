import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config";
import { emptyStore, newestId, type StoreData } from "../src/store";
import { runSync, type SyncOptions } from "../src/sync";
import { XClient } from "../src/x-client";
import { fakeX, makePost, ME } from "./fake-x";

const oauthConfig: Config = {
  auth: { kind: "oauth1", consumerKey: "k", consumerSecret: "s", token: "t", tokenSecret: "ts" },
  source: "env",
  dataDir: "unused",
  apiBase: "https://api.x.com",
  timezone: "UTC",
  problems: [],
};
const opts = (o: Partial<SyncOptions> = {}): SyncOptions => ({
  mode: "new",
  maxPosts: 200,
  refreshMetricsDays: 0,
  dryRun: false,
  ...o,
});
const NOW = new Date(Date.UTC(2026, 2, 1));

async function sync(store: StoreData, x: ReturnType<typeof fakeX>, o: Partial<SyncOptions> = {}, config = oauthConfig) {
  return runSync(new XClient(config.auth, config.apiBase, x.fetch), store, config, opts(o), NOW);
}

describe("runSync", () => {
  test("first sync fetches the most recent posts and prices them as owned reads", async () => {
    const x = fakeX(Array.from({ length: 30 }, (_, i) => makePost(i + 1)));
    const store = emptyStore();
    const r = await sync(store, x);
    expect(r.error).toBeUndefined();
    expect(r.posts_read).toBe(30);
    expect(r.added).toBe(30);
    expect(r.est_cost_usd).toBe(0.03);
    expect(store.user).toEqual(ME);
    expect(x.calls[0]!.pathname).toBe("/2/users/me");
    const tweetsCall = x.calls[1]!;
    expect(tweetsCall.searchParams.get("exclude")).toBe("retweets");
    expect(tweetsCall.searchParams.get("post.fields")).toContain("public_metrics");
  });

  test("a second sync only asks for newer posts and reads nothing when there are none", async () => {
    const x = fakeX(Array.from({ length: 10 }, (_, i) => makePost(i + 1)));
    const store = emptyStore();
    await sync(store, x);
    x.calls.length = 0;
    const r = await sync(store, x);
    expect(r.posts_read).toBe(0);
    expect(x.calls.map((c) => c.pathname)).toEqual([`/2/users/${ME.id}/tweets`]);
    expect(x.calls[0]!.searchParams.get("since_id")).toBe(newestId(store)!);

    x.timeline.push(makePost(11), makePost(12));
    const r2 = await sync(store, x);
    expect(r2.added).toBe(2);
    expect(Object.keys(store.posts)).toHaveLength(12);
  });

  test("respects max_posts and records the gap it leaves, then fills it", async () => {
    const x = fakeX(Array.from({ length: 5 }, (_, i) => makePost(i + 1)));
    const store = emptyStore();
    await sync(store, x);
    for (let i = 6; i <= 60; i++) x.timeline.push(makePost(i));

    const r = await sync(store, x, { maxPosts: 20 });
    expect(r.posts_read).toBe(20);
    expect(store.gaps).toHaveLength(1);
    expect(r.warnings.join(" ")).toContain("max_posts");

    const r2 = await sync(store, x, { maxPosts: 100 });
    expect(r2.added).toBe(35);
    expect(store.gaps).toHaveLength(0);
    expect(Object.keys(store.posts)).toHaveLength(60);
  });

  test("backfill walks older posts and detects the start of the timeline", async () => {
    const x = fakeX(Array.from({ length: 50 }, (_, i) => makePost(i + 1)));
    const store = emptyStore();
    await sync(store, x, { maxPosts: 20 });
    expect(Object.keys(store.posts)).toHaveLength(20);

    const r = await sync(store, x, { mode: "backfill", maxPosts: 100 });
    expect(r.added).toBe(30);
    expect(r.reached_timeline_start).toBe(true);
    const again = await sync(store, x, { mode: "backfill" });
    expect(again.posts_read).toBe(0);
  });

  test("keeps what was fetched and records a gap when the API fails mid-way", async () => {
    const store2 = emptyStore();
    const x2 = fakeX(Array.from({ length: 5 }, (_, i) => makePost(i + 1)));
    await sync(store2, x2);
    for (let i = 6; i <= 300; i++) x2.timeline.push(makePost(i));
    // tweets call 0 = first sync, 1 = first 100-post page, 2 = second page → 402
    x2.failOn = { calls: [2], status: 402 };
    const r2 = await sync(store2, x2, { maxPosts: 250 });
    expect(r2.error).toContain("402");
    expect(r2.error).toContain("credits");
    expect(r2.posts_read).toBe(100);
    expect(store2.gaps).toHaveLength(1);

    x2.failOn = undefined;
    await sync(store2, x2, { maxPosts: 500 });
    expect(Object.keys(store2.posts)).toHaveLength(300);
    expect(store2.gaps).toHaveLength(0);
  });

  test("falls back to legacy tweet.fields when the API rejects post.fields", async () => {
    const x = fakeX([
      makePost(1, { note_tweet: { text: "a long note ".repeat(40) }, referenced_tweets: undefined }),
    ]);
    x.legacyOnly = true;
    const store = emptyStore();
    const r = await sync(store, x);
    expect(r.error).toBeUndefined();
    expect(r.added).toBe(1);
    expect(x.calls.at(-1)!.searchParams.get("tweet.fields")).toContain("note_tweet");
    expect(Object.values(store.posts)[0]!.is_long).toBe(true);
  });

  test("an unrelated 400 keeps the current field names and surfaces the original error", async () => {
    const x = fakeX([makePost(1)]);
    const store = emptyStore();
    await sync(store, x);
    x.failOn = { calls: [1, 2], status: 400 };
    const r = await sync(store, x);
    expect(r.error).toContain("400");
    x.failOn = undefined;
    x.calls.length = 0;
    await sync(store, x);
    expect(x.calls.at(-1)!.searchParams.has("post.fields")).toBe(true);
  });

  test("refresh_metrics_days re-reads recent posts and asks for owner metrics only within 30 days", async () => {
    const recent = makePost(1, { created_at: new Date(NOW.getTime() - 2 * 86_400_000).toISOString() });
    const x = fakeX([recent]);
    const store = emptyStore();
    await sync(store, x);
    x.calls.length = 0;
    recent.public_metrics = { ...recent.public_metrics, like_count: 999 };

    const r = await sync(store, x, { refreshMetricsDays: 7 });
    expect(r.updated).toBe(1);
    expect(Object.values(store.posts)[0]!.metrics.likes).toBe(999);
    const refresh = x.calls.find((c) => c.searchParams.has("start_time"))!;
    expect(refresh.searchParams.get("post.fields")).toContain("organic_metrics");

    x.calls.length = 0;
    await sync(store, x, { refreshMetricsDays: 60 });
    expect(x.calls.find((c) => c.searchParams.has("start_time"))!.searchParams.get("post.fields")).not.toContain(
      "organic_metrics",
    );
  });

  test("dry run makes no API call and reports the worst-case cost", async () => {
    const x = fakeX([makePost(1)]);
    const r = await sync(emptyStore(), x, { dryRun: true, maxPosts: 500 });
    expect(x.calls).toHaveLength(0);
    expect(r.est_cost_usd).toBe(0.5);
  });

  test("bearer auth resolves the user by username and prices standard reads", async () => {
    const x = fakeX([makePost(1), makePost(2)]);
    const config: Config = { ...oauthConfig, auth: { kind: "bearer", token: "b" }, username: "tom" };
    const r = await sync(emptyStore(), x, {}, config);
    expect(x.calls[0]!.pathname).toBe("/2/users/by/username/tom");
    expect(r.est_cost_usd).toBe(0.01);
  });

  test("without credentials it returns an actionable error instead of throwing", async () => {
    const config: Config = { ...oauthConfig, auth: { kind: "none" }, problems: ["No X credentials configured."] };
    const r = await sync(emptyStore(), fakeX([]), {}, config);
    expect(r.error).toContain("No X credentials");
  });
});
