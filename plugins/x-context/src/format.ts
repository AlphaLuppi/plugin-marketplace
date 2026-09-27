import type { Bucket, WritingContext } from "./analytics";
import type { StoredPost } from "./store";
import type { SyncReport } from "./sync";

const STALE_MS = 24 * 3_600_000;

export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(n);
}

function localTime(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("weekday")} ${get("hour")}:${get("minute")}`;
}

export function renderPost(
  p: StoredPost,
  opts: { username?: string; timezone: string; score?: number },
): string {
  const m = p.metrics;
  const stats = [
    `${compact(m.impressions)} views`,
    `${compact(m.likes)} likes`,
    `${compact(m.reposts)} reposts`,
    `${compact(m.replies)} replies`,
    `${compact(m.quotes)} quotes`,
    `${compact(m.bookmarks)} bookmarks`,
  ];
  if (opts.score !== undefined) stats.push(`×${opts.score.toFixed(1)} vs usual`);
  const flags = [
    p.kind,
    p.has_media && "media",
    p.has_poll && "poll",
    p.has_link && "link",
    p.article_title && `article: "${p.article_title}"`,
  ].filter(Boolean);
  const privateStats = p.private_metrics
    ? `\n  owner metrics: ${Object.entries(p.private_metrics).map(([k, v]) => `${k}=${v}`).join(", ")}`
    : "";
  const url = `https://x.com/${opts.username?.replace(/^@/, "") ?? "i"}/status/${p.id}`;
  const body = p.text
    .trim()
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `[${localTime(p.created_at, opts.timezone)} · ${flags.join(" · ")}] ${stats.join(" · ")}${privateStats}\n  ${url}\n${body}`;
}

function renderBuckets(title: string, buckets: Bucket[]): string {
  if (buckets.length === 0) return "";
  const rows = buckets.map(
    (b) =>
      `| ${b.label} | ${b.n} | ×${b.median_outperformance.toFixed(2)} | ${compact(b.median_engagement)} | ${compact(b.median_impressions)} |`,
  );
  return [`**${title}**`, "| bucket | posts | median ×usual | median engagement | median views |", "|---|---|---|---|---|", ...rows].join("\n");
}

export function freshness(lastSyncAt: string | undefined, now = Date.now()): string {
  if (!lastSyncAt) return "Never synced — call x_sync first.";
  const hours = Math.round((now - Date.parse(lastSyncAt)) / 3_600_000);
  const ago = hours < 1 ? "less than an hour ago" : hours < 48 ? `${hours}h ago` : `${Math.round(hours / 24)} days ago`;
  return now - Date.parse(lastSyncAt) > STALE_MS
    ? `Last synced ${ago} — stale, consider x_sync (mode "new").`
    : `Last synced ${ago}.`;
}

export function renderWritingContext(ctx: WritingContext, now = Date.now()): string {
  const tz = ctx.timezone;
  const out: string[] = [];
  out.push(`# Writing context for ${ctx.user ?? "(unknown account)"}`);
  out.push(
    `${freshness(ctx.cache.last_sync_at, now)} Cache: ${ctx.cache.total} posts` +
      (ctx.cache.oldest ? ` from ${ctx.cache.oldest.slice(0, 10)} to ${ctx.cache.newest?.slice(0, 10)}` : "") +
      `. Analysis window: last ${ctx.window_days} days, times in ${tz}.`,
  );
  if (ctx.cache.unsettled > 0) {
    out.push(
      `${ctx.cache.unsettled} original posts were captured < 48h after publishing, so their metrics are ` +
        `excluded from rankings. x_sync with refresh_metrics_days=7 updates them.`,
    );
  }
  if (ctx.voice.n === 0) {
    out.push("\nNo original posts in the window. Sync more history (x_sync mode \"backfill\") or widen `days`.");
    return out.join("\n");
  }

  out.push("\n## How I write (original posts in window)");
  const v = ctx.voice;
  out.push(
    `${v.n} posts · median ${v.median_chars} chars · ${v.pct_multiline}% multi-line · ${v.pct_question}% contain a question · ` +
      `${v.pct_emoji}% emoji · ${v.pct_hashtag}% hashtags · ${v.pct_link}% links · ${v.pct_media}% media · ` +
      `languages: ${v.langs.map((l) => `${l.lang} ${l.n}`).join(", ")}`,
  );
  const c = ctx.cadence;
  out.push(
    `Cadence: ${c.last_7d} in 7d, ${c.last_30d} in 30d, ${c.last_90d} in 90d (${c.per_week_90d}/week)` +
      (c.last_post_at ? `; last original post ${localTime(c.last_post_at, tz)}.` : "."),
  );
  if (ctx.replies.n > 0) {
    out.push(`Replies to others: ${ctx.replies.n} (median engagement ${compact(ctx.replies.median_engagement)}).`);
  }

  out.push("\n## What performs");
  out.push(
    "×usual = engagement (likes+reposts+replies+quotes+bookmarks) divided by my median over the surrounding ±45 days. " +
      `Buckets with fewer than 3 posts are hidden.`,
  );
  for (const [title, buckets] of Object.entries(ctx.breakdowns)) {
    const table = renderBuckets(title, buckets);
    if (table) out.push(`\n${table}`);
  }

  const section = (title: string, items: { post: StoredPost; score?: number }[]) => {
    if (items.length === 0) return;
    out.push(`\n## ${title}`);
    for (const { post, score } of items) out.push(`\n${renderPost(post, { username: ctx.user, timezone: tz, score })}`);
  };
  section("Top posts (best relative to my usual)", ctx.top);
  section("Weakest posts (learn what to avoid)", ctx.bottom);
  section("Most recent posts (don't repeat these)", ctx.recent);
  return out.join("\n");
}

export function renderList(
  items: { post: StoredPost; score?: number }[],
  opts: { username?: string; timezone: string; lastSyncAt?: string; total: number },
): string {
  const head = `${items.length} of ${opts.total} cached posts. ${freshness(opts.lastSyncAt)}`;
  if (items.length === 0) return `${head}\nNo match.`;
  return [head, ...items.map(({ post, score }) => renderPost(post, { ...opts, score }))].join("\n\n");
}

export function renderSyncReport(r: SyncReport): string {
  const lines = [
    `${r.dry_run ? "Dry run" : r.error ? "Sync stopped" : "Sync done"} for ${r.user ?? "(account not resolved yet)"} (auth: ${r.auth}, mode: ${r.mode}).`,
    `Posts read from the API: ${r.posts_read} (${r.added} new, ${r.updated} refreshed) · estimated cost $${r.est_cost_usd.toFixed(3)}.`,
    `Cache: ${r.total_cached} posts · ${r.gaps_remaining} unfetched gap(s) · ` +
      (r.reached_timeline_start ? "full available history fetched." : "older history available via mode \"backfill\"."),
  ];
  if (r.error) lines.push(`Error: ${r.error}`);
  for (const w of r.warnings) lines.push(`Note: ${w}`);
  return lines.join("\n");
}
