import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RawPost, XUser } from "./x-client";

export type PostKind = "post" | "thread" | "reply" | "quote";

export interface Metrics {
  likes: number;
  reposts: number;
  replies: number;
  quotes: number;
  bookmarks: number;
  impressions: number;
}

export interface StoredPost {
  id: string;
  text: string;
  created_at: string;
  kind: PostKind;
  conversation_id?: string;
  lang?: string;
  metrics: Metrics;
  /** Owner-only metrics (profile clicks, link clicks…), last 30 days, OAuth 1.0a only. */
  private_metrics?: Record<string, number>;
  has_media: boolean;
  has_poll: boolean;
  has_link: boolean;
  hashtags: string[];
  is_long: boolean;
  article_title?: string;
  first_seen_at: string;
  metrics_updated_at: string;
  /** Set by the API's `in_reply_to_user_id` or `referenced_*` when available; used for classification. */
  refs?: { replied_to?: string; quoted?: string; in_reply_to_user_id?: string };
}

/** A range of the timeline we know exists but haven't fetched yet (budget ran out mid-way). */
export interface Gap {
  since_id: string;
  until_id: string;
}

export interface StoreData {
  version: 1;
  user?: XUser;
  posts: Record<string, StoredPost>;
  gaps: Gap[];
  reached_timeline_start: boolean;
  last_sync_at?: string;
  spend: { at: string; posts_read: number; est_cost_usd: number; auth: string }[];
}

export function emptyStore(): StoreData {
  return { version: 1, posts: {}, gaps: [], reached_timeline_start: false, spend: [] };
}

export function storePath(dataDir: string): string {
  return join(dataDir, "posts.json");
}

export async function loadStore(dataDir: string): Promise<StoreData> {
  try {
    const parsed = JSON.parse(await readFile(storePath(dataDir), "utf8")) as Partial<StoreData>;
    return { ...emptyStore(), ...parsed, posts: parsed.posts ?? {}, gaps: parsed.gaps ?? [] };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStore();
    throw new Error(`Cannot read ${storePath(dataDir)}: ${(err as Error).message}`);
  }
}

export async function saveStore(dataDir: string, store: StoreData): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const target = storePath(dataDir);
  const tmp = `${target}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(store), "utf8");
  await rename(tmp, target);
}

/** Snowflake IDs exceed 2^53, so compare them as BigInt. */
export function compareIds(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

export function newestId(store: StoreData): string | undefined {
  return Object.keys(store.posts).reduce<string | undefined>(
    (max, id) => (max === undefined || compareIds(id, max) > 0 ? id : max),
    undefined,
  );
}

export function oldestId(store: StoreData): string | undefined {
  return Object.keys(store.posts).reduce<string | undefined>(
    (min, id) => (min === undefined || compareIds(id, min) < 0 ? id : min),
    undefined,
  );
}

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/[^/]+\/status\/(\d+)/i;

export function normalizePost(raw: RawPost, now: string): StoredPost {
  const pm = raw.public_metrics ?? {};
  const refs = raw.referenced_posts ?? raw.referenced_tweets ?? [];
  const urls = raw.entities?.urls ?? [];
  const quotedFromUrl = urls
    .map((u) => STATUS_URL.exec(u.expanded_url ?? "")?.[1])
    .find((id): id is string => Boolean(id));

  const replied = refs.find((r) => r.type === "replied_to")?.id;
  const quoted = refs.find((r) => r.type === "quoted")?.id ?? quotedFromUrl;
  const isReply = Boolean(replied || raw.in_reply_to_user_id) ||
    (raw.conversation_id !== undefined && raw.conversation_id !== raw.id);

  const noteText = raw.note_post?.text ?? raw.note_tweet?.text;
  const text = noteText ?? raw.text;
  const privateMetrics = { ...(raw.non_public_metrics ?? {}), ...(raw.organic_metrics ?? {}) };
  const articleTitle = raw.article_title ?? (typeof raw.article?.title === "string" ? raw.article.title : undefined);

  return {
    id: raw.id,
    text,
    created_at: raw.created_at ?? now,
    kind: isReply ? "reply" : quoted ? "quote" : "post",
    conversation_id: raw.conversation_id,
    lang: raw.lang,
    metrics: {
      likes: pm.like_count ?? 0,
      reposts: pm.repost_count ?? pm.retweet_count ?? 0,
      replies: pm.reply_count ?? 0,
      quotes: pm.quote_count ?? 0,
      bookmarks: pm.bookmark_count ?? 0,
      impressions: pm.impression_count ?? 0,
    },
    private_metrics: Object.keys(privateMetrics).length ? privateMetrics : undefined,
    has_media: (raw.attachments?.media_keys?.length ?? 0) > 0,
    has_poll: (raw.attachments?.poll_ids?.length ?? 0) > 0,
    has_link: urls.some((u) => u.expanded_url && !STATUS_URL.test(u.expanded_url) && !/\/(photo|video)\/\d+$/.test(u.expanded_url)),
    hashtags: (raw.entities?.hashtags ?? []).map((h) => h.tag),
    is_long: Boolean(noteText) || text.length > 280,
    article_title: articleTitle,
    first_seen_at: now,
    metrics_updated_at: now,
    refs:
      replied || quoted || raw.in_reply_to_user_id
        ? { replied_to: replied, quoted, in_reply_to_user_id: raw.in_reply_to_user_id }
        : undefined,
  };
}

/** Inserts or refreshes posts. Returns how many were new. */
export function mergePosts(store: StoreData, posts: StoredPost[]): { added: number; updated: number } {
  let added = 0;
  let updated = 0;
  for (const post of posts) {
    const existing = store.posts[post.id];
    if (existing) {
      store.posts[post.id] = {
        ...post,
        first_seen_at: existing.first_seen_at,
        private_metrics: post.private_metrics ?? existing.private_metrics,
      };
      updated++;
    } else {
      store.posts[post.id] = post;
      added++;
    }
  }
  return { added, updated };
}

/**
 * A reply inside a conversation I started (or to myself) is a thread
 * continuation, which reads like my own writing rather than a conversation.
 */
export function reclassify(store: StoreData): void {
  const myId = store.user?.id;
  for (const post of Object.values(store.posts)) {
    if (post.kind !== "reply" && post.kind !== "thread") continue;
    const selfReply = myId !== undefined && post.refs?.in_reply_to_user_id === myId;
    const rootIsMine = post.conversation_id !== undefined && post.conversation_id in store.posts;
    post.kind = selfReply || rootIsMine ? "thread" : "reply";
  }
}
