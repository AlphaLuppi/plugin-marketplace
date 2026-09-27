import type { Auth } from "./config";
import { oauth1Header } from "./oauth1";

export interface XUser {
  id: string;
  username: string;
  name: string;
}

/** Raw post as returned by the API. Tolerates both the current (`post`) and legacy (`tweet`) names. */
export interface RawPost {
  id: string;
  text: string;
  created_at?: string;
  conversation_id?: string;
  in_reply_to_user_id?: string;
  lang?: string;
  public_metrics?: Record<string, number>;
  non_public_metrics?: Record<string, number>;
  organic_metrics?: Record<string, number>;
  entities?: {
    urls?: { expanded_url?: string; url?: string }[];
    hashtags?: { tag: string }[];
  };
  attachments?: { media_keys?: string[] | null; poll_ids?: string[] | null };
  note_post?: { text: string };
  note_tweet?: { text: string };
  referenced_posts?: { type: string; id: string }[];
  referenced_tweets?: { type: string; id: string }[];
  article?: { title?: string } & Record<string, unknown>;
  article_title?: string;
}

export interface PostsPage {
  data?: RawPost[];
  meta?: { next_token?: string; newest_id?: string; oldest_id?: string; result_count?: number };
  errors?: { title?: string; detail?: string; resource_id?: string }[];
}

export interface PostsQuery {
  since_id?: string;
  until_id?: string;
  start_time?: string;
  max_results: number;
  pagination_token?: string;
  withPrivateMetrics?: boolean;
}

export class XApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = "XApiError";
  }
}

/**
 * Field names changed when X renamed "tweets" to "posts" in the v2 spec. The
 * current spec only lists `post.fields`; we retry once with the legacy names on
 * a 400 so the plugin keeps working whichever side of the rename the API is on.
 */
const FIELD_STYLES = {
  post: {
    param: "post.fields",
    fields: ["created_at", "public_metrics", "conversation_id", "entities", "attachments", "lang", "note_post", "article"],
  },
  tweet: {
    param: "tweet.fields",
    fields: [
      "created_at",
      "public_metrics",
      "conversation_id",
      "entities",
      "attachments",
      "lang",
      "note_tweet",
      "referenced_tweets",
      "in_reply_to_user_id",
    ],
  },
} as const;
type FieldStyle = keyof typeof FIELD_STYLES;

export class XClient {
  private fieldStyle: FieldStyle = "post";

  constructor(
    private readonly auth: Auth,
    private readonly apiBase = "https://api.x.com",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getMe(): Promise<XUser> {
    const body = await this.get<{ data: XUser }>("/2/users/me", {});
    return body.data;
  }

  async getUserByUsername(username: string): Promise<XUser> {
    const body = await this.get<{ data?: XUser; errors?: { detail?: string }[] }>(
      `/2/users/by/username/${encodeURIComponent(username)}`,
      {},
    );
    if (!body.data) {
      throw new XApiError(body.errors?.[0]?.detail ?? `User @${username} not found.`, 404, body);
    }
    return body.data;
  }

  async getUserPosts(userId: string, query: PostsQuery): Promise<PostsPage> {
    try {
      return await this.get<PostsPage>(`/2/users/${userId}/tweets`, this.postsParams(query));
    } catch (err) {
      if (!(err instanceof XApiError && err.status === 400 && this.fieldStyle === "post")) throw err;
      this.fieldStyle = "tweet";
      try {
        return await this.get<PostsPage>(`/2/users/${userId}/tweets`, this.postsParams(query));
      } catch {
        // The 400 wasn't about field names: keep the current naming, report the original error.
        this.fieldStyle = "post";
        throw err;
      }
    }
  }

  private postsParams(query: PostsQuery): Record<string, string | undefined> {
    const style = FIELD_STYLES[this.fieldStyle];
    const fields: string[] = [...style.fields];
    if (query.withPrivateMetrics) fields.push("non_public_metrics", "organic_metrics");
    return {
      max_results: String(Math.min(100, Math.max(5, query.max_results))),
      exclude: "retweets",
      [style.param]: fields.join(","),
      since_id: query.since_id,
      until_id: query.until_id,
      start_time: query.start_time,
      pagination_token: query.pagination_token,
    };
  }

  private async get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
    const url = new URL(this.apiBase + path);
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    const href = url.toString();

    const headers: Record<string, string> = { "User-Agent": "x-context-mcp/0.1" };
    if (this.auth.kind === "oauth1") headers.Authorization = oauth1Header("GET", href, this.auth);
    else if (this.auth.kind === "bearer") headers.Authorization = `Bearer ${this.auth.token}`;
    else throw new XApiError("No X credentials configured.", 0);

    const res = await this.fetchImpl(href, { headers });
    const text = await res.text();
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      body = text;
    }
    if (!res.ok) throw new XApiError(describeError(res, body), res.status, body);
    return body as T;
  }
}

function describeError(res: Response, body: unknown): string {
  const detail =
    typeof body === "object" && body !== null
      ? String((body as { detail?: string; title?: string }).detail ?? (body as { title?: string }).title ?? "")
      : String(body).slice(0, 300);
  const prefix = `X API ${res.status}${detail ? `: ${detail}` : ""}`;
  switch (res.status) {
    case 401:
      return `${prefix} — credentials rejected. Regenerate the keys in console.x.com and update the plugin settings.`;
    case 402:
      return `${prefix} — no credits left or the spend cap was reached. Buy credits or raise the cap in console.x.com.`;
    case 403:
      return `${prefix} — the app lacks access to this endpoint (check the app is attached to a project with credits and has Read permission).`;
    case 429: {
      const reset = Number(res.headers.get("x-rate-limit-reset"));
      const when = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "later";
      return `${prefix} — rate limited. Retry after ${when}.`;
    }
    default:
      return prefix;
  }
}
