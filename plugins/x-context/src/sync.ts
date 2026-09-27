import { costPerPost, type Config } from "./config";
import {
  mergePosts,
  newestId,
  normalizePost,
  oldestId,
  reclassify,
  type Gap,
  type StoreData,
} from "./store";
import { XApiError, type XClient, type XUser } from "./x-client";

export interface SyncOptions {
  /** "new": fetch posts newer than the cache (and fill known gaps). "backfill": walk further back in time. */
  mode: "new" | "backfill";
  /** Hard cap on posts read from the API in this call (each one is billed). */
  maxPosts: number;
  /** Re-read posts from the last N days to refresh their engagement numbers. 0 disables. */
  refreshMetricsDays: number;
  dryRun: boolean;
}

export interface SyncReport {
  user?: string;
  auth: string;
  /** "env" = host settings (plugin / extension), "file" = saved by x_connect. */
  source: string;
  mode: SyncOptions["mode"];
  dry_run: boolean;
  posts_read: number;
  added: number;
  updated: number;
  est_cost_usd: number;
  total_cached: number;
  gaps_remaining: number;
  reached_timeline_start: boolean;
  warnings: string[];
  error?: string;
}

interface Range {
  since_id?: string;
  until_id?: string;
  start_time?: string;
  withPrivateMetrics?: boolean;
}

/** The API only returns the ~3,200 most recent posts of a timeline. */
const TIMELINE_DEPTH = 3200;

export async function runSync(
  client: XClient,
  store: StoreData,
  config: Config,
  opts: SyncOptions,
  now: Date = new Date(),
): Promise<SyncReport> {
  const rate = costPerPost(config.auth);
  const report: SyncReport = {
    user: store.user ? `@${store.user.username}` : config.username ? `@${config.username}` : undefined,
    auth: config.auth.kind,
    source: config.source,
    mode: opts.mode,
    dry_run: opts.dryRun,
    posts_read: 0,
    added: 0,
    updated: 0,
    est_cost_usd: 0,
    total_cached: Object.keys(store.posts).length,
    gaps_remaining: store.gaps.length,
    reached_timeline_start: store.reached_timeline_start,
    warnings: [...config.problems],
  };

  if (opts.dryRun) {
    report.est_cost_usd = round(opts.maxPosts * rate);
    report.warnings.push(
      `Dry run: no API call made. A real run reads at most ${opts.maxPosts} posts ` +
        `(≤ $${report.est_cost_usd.toFixed(3)} at $${rate}/post with ${config.auth.kind} auth)` +
        (store.user ? "." : ", plus one user lookup."),
    );
    return report;
  }
  if (config.auth.kind === "none") {
    report.error = config.problems.join(" ");
    return report;
  }

  const nowIso = now.toISOString();
  let budget = opts.maxPosts;

  /** Walks a range newest-first. `progress.oldest` survives a mid-walk failure. */
  const fetchRange = async (range: Range, progress: { oldest?: string } = {}): Promise<boolean> => {
    let token: string | undefined;
    while (budget > 0) {
      const page = await client.getUserPosts(store.user!.id, {
        ...range,
        max_results: Math.min(100, budget),
        pagination_token: token,
      });
      const posts = (page.data ?? []).map((raw) => normalizePost(raw, nowIso));
      budget -= posts.length;
      report.posts_read += posts.length;
      const merged = mergePosts(store, posts);
      report.added += merged.added;
      report.updated += merged.updated;
      if (page.meta?.oldest_id) progress.oldest = page.meta.oldest_id;
      for (const e of page.errors ?? []) {
        report.warnings.push(`Partial error${e.resource_id ? ` on ${e.resource_id}` : ""}: ${e.detail ?? e.title}`);
      }
      token = page.meta?.next_token;
      if (!token || posts.length === 0) return true;
    }
    return false;
  };

  // A newest-first walk bounded by since_id that stops early (budget or error)
  // leaves a hole between the previous head and the oldest post reached.
  const fetchBounded = async (gap: Partial<Gap>): Promise<void> => {
    const progress: { oldest?: string } = {};
    let complete = false;
    try {
      complete = await fetchRange(gap, progress);
    } finally {
      const until = progress.oldest ?? gap.until_id;
      if (!complete && gap.since_id && until) store.gaps.push({ since_id: gap.since_id, until_id: until });
    }
  };

  try {
    store.user = await resolveUser(client, store, config, report);

    if (opts.mode === "new") {
      await fetchBounded({ since_id: newestId(store) });
    } else if (store.reached_timeline_start) {
      report.warnings.push(
        `Backfill already reached the start of what the API exposes (≈${TIMELINE_DEPTH} most recent posts).`,
      );
    } else {
      if (await fetchRange({ until_id: oldestId(store) })) store.reached_timeline_start = true;
    }

    const pending = store.gaps.splice(0);
    for (const [i, gap] of pending.entries()) {
      if (budget <= 0) {
        store.gaps.push(...pending.slice(i));
        break;
      }
      await fetchBounded(gap);
    }

    if (opts.refreshMetricsDays > 0 && budget > 0) {
      const days = opts.refreshMetricsDays;
      // Owner-only metrics are served for the last 30 days only; asking for
      // them on an older post fails the request.
      const withPrivateMetrics = config.auth.kind === "oauth1" && days <= 29;
      await fetchRange({
        start_time: new Date(now.getTime() - days * 86_400_000).toISOString(),
        withPrivateMetrics,
      });
    }
    if (budget <= 0) {
      report.warnings.push(`Stopped at the max_posts budget (${opts.maxPosts}). Run x_sync again to continue.`);
    }
  } catch (err) {
    report.error = err instanceof XApiError ? err.message : `Sync failed: ${(err as Error).message}`;
  } finally {
    reclassify(store);
    report.est_cost_usd = round(report.posts_read * rate);
    if (report.posts_read > 0) {
      store.last_sync_at = nowIso;
      store.spend = [
        ...store.spend,
        { at: nowIso, posts_read: report.posts_read, est_cost_usd: report.est_cost_usd, auth: config.auth.kind },
      ].slice(-200);
    }
    report.user = store.user ? `@${store.user.username}` : report.user;
    report.total_cached = Object.keys(store.posts).length;
    report.gaps_remaining = store.gaps.length;
    report.reached_timeline_start = store.reached_timeline_start;
  }
  return report;
}

async function resolveUser(
  client: XClient,
  store: StoreData,
  config: Config,
  report: SyncReport,
): Promise<XUser> {
  const cached = store.user;
  let user: XUser;
  if (config.auth.kind === "oauth1") {
    user = cached ?? (await client.getMe());
    if (config.username && config.username.toLowerCase() !== user.username.toLowerCase()) {
      report.warnings.push(
        `X_USERNAME is @${config.username} but the OAuth keys belong to @${user.username}; using @${user.username}.`,
      );
    }
  } else {
    if (!config.username) throw new Error("Bearer auth needs X_USERNAME.");
    user =
      cached && cached.username.toLowerCase() === config.username.toLowerCase()
        ? cached
        : await client.getUserByUsername(config.username);
  }
  if (cached && cached.id !== user.id) {
    report.warnings.push(`Account changed from @${cached.username} to @${user.username}: cache reset.`);
    store.posts = {};
    store.gaps = [];
    store.reached_timeline_start = false;
  }
  return user;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}
