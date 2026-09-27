import type { Metrics, StoredPost, StoreData } from "./store";

const DAY = 86_400_000;
/** Engagement keeps moving for a couple of days; younger snapshots aren't comparable. */
export const SETTLE_MS = 2 * DAY;
const BASELINE_WINDOW_MS = 45 * DAY;
const MIN_BUCKET = 3;

export function engagement(m: Metrics): number {
  return m.likes + m.reposts + m.replies + m.quotes + m.bookmarks;
}

export function engagementRate(p: StoredPost): number | undefined {
  return p.metrics.impressions > 0 ? engagement(p.metrics) / p.metrics.impressions : undefined;
}

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** Standalone writing: posts, quotes and thread openers (not replies or thread continuations). */
export function isOriginal(p: StoredPost): boolean {
  return p.kind === "post" || p.kind === "quote";
}

export function isSettled(p: StoredPost): boolean {
  return Date.parse(p.metrics_updated_at) - Date.parse(p.created_at) >= SETTLE_MS;
}

/**
 * Outperformance = engagement relative to the median of my other original posts
 * published within ±45 days. It neutralises audience growth: a 2023 post with
 * 40 likes can beat a 2026 post with 120.
 */
export function outperformance(posts: StoredPost[]): Map<string, number> {
  const originals = posts
    .filter((p) => isOriginal(p) && isSettled(p))
    .map((p) => ({ p, t: Date.parse(p.created_at), e: engagement(p.metrics) }))
    .sort((a, b) => a.t - b.t);
  const globalMedian = median(originals.map((o) => o.e));
  const scores = new Map<string, number>();
  let lo = 0;
  let hi = 0;
  for (const [i, o] of originals.entries()) {
    while (originals[lo]!.t < o.t - BASELINE_WINDOW_MS) lo++;
    while (hi < originals.length && originals[hi]!.t <= o.t + BASELINE_WINDOW_MS) hi++;
    const peers = originals.slice(lo, hi).filter((_, j) => j + lo !== i).map((x) => x.e);
    const baseline = peers.length >= 5 ? median(peers) : globalMedian;
    scores.set(o.p.id, (o.e + 1) / (baseline + 1));
  }
  return scores;
}

export interface Bucket {
  label: string;
  n: number;
  median_engagement: number;
  median_outperformance: number;
  median_impressions: number;
}

export interface WritingContext {
  user?: string;
  timezone: string;
  window_days: number;
  cache: { total: number; last_sync_at?: string; newest?: string; oldest?: string; unsettled: number };
  cadence: { last_7d: number; last_30d: number; last_90d: number; per_week_90d: number; last_post_at?: string };
  voice: {
    n: number;
    median_chars: number;
    pct_question: number;
    pct_multiline: number;
    pct_hashtag: number;
    pct_link: number;
    pct_media: number;
    pct_emoji: number;
    langs: { lang: string; n: number }[];
  };
  breakdowns: Record<string, Bucket[]>;
  replies: { n: number; median_engagement: number };
  top: { post: StoredPost; score: number }[];
  bottom: { post: StoredPost; score: number }[];
  recent: { post: StoredPost; score?: number }[];
}

export interface ContextOptions {
  days: number;
  top: number;
  bottom: number;
  recent: number;
  timezone: string;
  lang?: string;
  now?: Date;
}

export function buildWritingContext(store: StoreData, opts: ContextOptions): WritingContext {
  const now = (opts.now ?? new Date()).getTime();
  const all = Object.values(store.posts);
  const scores = outperformance(all);
  const since = now - opts.days * DAY;
  const threadRoots = new Set(all.filter((p) => p.kind === "thread").map((p) => p.conversation_id));

  const inWindow = all.filter(
    (p) => Date.parse(p.created_at) >= since && (!opts.lang || p.lang === opts.lang),
  );
  const originals = inWindow.filter(isOriginal).sort(byNewest);
  const ranked = originals.filter((p) => scores.has(p.id));
  const replies = inWindow.filter((p) => p.kind === "reply" && isSettled(p));

  const hourFmt = new Intl.DateTimeFormat("en-GB", { hour: "numeric", hourCycle: "h23", timeZone: opts.timezone });
  const dayFmt = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: opts.timezone });
  const hourBlock = (p: StoredPost) => {
    const h = Number(hourFmt.format(new Date(p.created_at))) % 24;
    const start = h - (h % 3);
    return `${pad(start)}h–${pad(start + 3)}h`;
  };

  const bucketize = (label: (p: StoredPost) => string, order?: string[]): Bucket[] => {
    const groups = new Map<string, StoredPost[]>();
    for (const p of ranked) {
      const key = label(p);
      groups.set(key, [...(groups.get(key) ?? []), p]);
    }
    const buckets = [...groups.entries()]
      .filter(([, ps]) => ps.length >= MIN_BUCKET)
      .map(([key, ps]) => ({
        label: key,
        n: ps.length,
        median_engagement: median(ps.map((p) => engagement(p.metrics))),
        median_outperformance: round2(median(ps.map((p) => scores.get(p.id)!))),
        median_impressions: median(ps.map((p) => p.metrics.impressions)),
      }));
    return order
      ? buckets.sort((a, b) => order.indexOf(a.label) - order.indexOf(b.label))
      : buckets.sort((a, b) => b.median_outperformance - a.median_outperformance);
  };

  const count = (days: number) => originals.filter((p) => Date.parse(p.created_at) >= now - days * DAY).length;
  const pct = (pred: (p: StoredPost) => boolean) =>
    originals.length ? Math.round((100 * originals.filter(pred).length) / originals.length) : 0;
  const langs = new Map<string, number>();
  for (const p of originals) langs.set(p.lang ?? "?", (langs.get(p.lang ?? "?") ?? 0) + 1);

  const byScore = [...ranked].sort((a, b) => scores.get(b.id)! - scores.get(a.id)!);
  const topIds = new Set(byScore.slice(0, opts.top).map((p) => p.id));

  return {
    user: store.user ? `@${store.user.username}` : undefined,
    timezone: opts.timezone,
    window_days: opts.days,
    cache: {
      total: all.length,
      last_sync_at: store.last_sync_at,
      newest: all.reduce<string | undefined>((m, p) => (!m || p.created_at > m ? p.created_at : m), undefined),
      oldest: all.reduce<string | undefined>((m, p) => (!m || p.created_at < m ? p.created_at : m), undefined),
      unsettled: all.filter((p) => isOriginal(p) && !isSettled(p)).length,
    },
    cadence: {
      last_7d: count(7),
      last_30d: count(30),
      last_90d: count(90),
      per_week_90d: round2((count(90) / 90) * 7),
      last_post_at: originals[0]?.created_at,
    },
    voice: {
      n: originals.length,
      median_chars: median(originals.map((p) => [...p.text].length)),
      pct_question: pct((p) => p.text.includes("?")),
      pct_multiline: pct((p) => p.text.trim().includes("\n")),
      pct_hashtag: pct((p) => p.hashtags.length > 0),
      pct_link: pct((p) => p.has_link),
      pct_media: pct((p) => p.has_media),
      pct_emoji: pct((p) => /\p{Extended_Pictographic}/u.test(p.text)),
      langs: [...langs.entries()].map(([lang, n]) => ({ lang, n })).sort((a, b) => b.n - a.n),
    },
    breakdowns: {
      format: bucketize((p) =>
        p.kind === "quote" ? "quote" : threadRoots.has(p.id) ? "thread opener" : p.is_long ? "long post (>280)" : "single post",
      ),
      length: bucketize(
        (p) => {
          const n = [...p.text].length;
          return n <= 100 ? "≤100 chars" : n <= 200 ? "101–200 chars" : n <= 280 ? "201–280 chars" : ">280 chars";
        },
        ["≤100 chars", "101–200 chars", "201–280 chars", ">280 chars"],
      ),
      attachment: bucketize((p) => (p.has_media ? "media" : p.has_poll ? "poll" : p.has_link ? "link" : "text only")),
      hour: bucketize(hourBlock, Array.from({ length: 8 }, (_, i) => `${pad(i * 3)}h–${pad(i * 3 + 3)}h`)),
      weekday: bucketize((p) => dayFmt.format(new Date(p.created_at)), ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]),
    },
    replies: { n: replies.length, median_engagement: median(replies.map((p) => engagement(p.metrics))) },
    top: byScore.slice(0, opts.top).map((post) => ({ post, score: scores.get(post.id)! })),
    bottom: byScore
      .slice(opts.bottom > 0 ? -opts.bottom : byScore.length)
      .reverse()
      .filter((p) => !topIds.has(p.id))
      .map((post) => ({ post, score: scores.get(post.id)! })),
    recent: originals.slice(0, opts.recent).map((post) => ({ post, score: scores.get(post.id) })),
  };
}

export type SortKey = "recent" | "engagement" | "impressions" | "engagement_rate" | "outperformance";
export type KindFilter = "all" | "original" | "post" | "quote" | "thread" | "reply";

export interface ListOptions {
  kind: KindFilter;
  query?: string;
  since?: string;
  until?: string;
  sort: SortKey;
  limit: number;
  minImpressions: number;
}

export function listPosts(store: StoreData, opts: ListOptions): { post: StoredPost; score?: number }[] {
  const all = Object.values(store.posts);
  const scores = outperformance(all);
  const terms = (opts.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const since = opts.since ? Date.parse(opts.since) : -Infinity;
  const until = opts.until ? Date.parse(opts.until) : Infinity;

  const matches = all.filter((p) => {
    if (opts.kind === "original" ? !isOriginal(p) : opts.kind !== "all" && p.kind !== opts.kind) return false;
    const t = Date.parse(p.created_at);
    if (t < since || t > until) return false;
    if (p.metrics.impressions < opts.minImpressions) return false;
    const text = p.text.toLowerCase();
    return terms.every((term) => text.includes(term));
  });

  const key: Record<SortKey, (p: StoredPost) => number> = {
    recent: (p) => Date.parse(p.created_at),
    engagement: (p) => engagement(p.metrics),
    impressions: (p) => p.metrics.impressions,
    engagement_rate: (p) => engagementRate(p) ?? -1,
    outperformance: (p) => scores.get(p.id) ?? -1,
  };
  return matches
    .sort((a, b) => key[opts.sort](b) - key[opts.sort](a))
    .slice(0, opts.limit)
    .map((post) => ({ post, score: scores.get(post.id) }));
}

function byNewest(a: StoredPost, b: StoredPost): number {
  return Date.parse(b.created_at) - Date.parse(a.created_at);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
