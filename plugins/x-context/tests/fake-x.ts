import type { RawPost } from "../src/x-client";

export const ME = { id: "42", username: "tom", name: "Tom" };

/** Base snowflake so ids exceed Number.MAX_SAFE_INTEGER, like real ones. */
const BASE = 1_800_000_000_000_000_000n;

export function makePost(i: number, overrides: Partial<RawPost> = {}): RawPost {
  const id = (BASE + BigInt(i)).toString();
  return {
    id,
    text: `post number ${i}`,
    created_at: new Date(Date.UTC(2026, 0, 1) + i * 3_600_000 * 6).toISOString(),
    conversation_id: id,
    lang: "en",
    public_metrics: {
      like_count: i,
      repost_count: 1,
      reply_count: 1,
      quote_count: 0,
      bookmark_count: 0,
      impression_count: 100 * i,
    },
    ...overrides,
  };
}

export interface FakeX {
  fetch: typeof fetch;
  calls: URL[];
  timeline: RawPost[];
  /** Makes these (0-based) tweets calls fail with this status. */
  failOn?: { calls: number[]; status: number };
  /** Reject `post.fields` with a 400, like an API still on legacy names. */
  legacyOnly?: boolean;
  /** Answer 401 to every call, like X does for bad keys. */
  rejectAuth?: boolean;
}

/** Minimal in-memory stand-in for the X v2 endpoints the plugin uses. */
export function fakeX(timeline: RawPost[]): FakeX {
  const state: FakeX = { calls: [], timeline, fetch: undefined as unknown as typeof fetch };
  let tweetCalls = 0;

  state.fetch = (async (input: string | URL | Request) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    state.calls.push(url);
    if (state.rejectAuth) {
      return new Response(JSON.stringify({ title: "Unauthorized", detail: "Unauthorized" }), { status: 401 });
    }
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

    if (url.pathname === "/2/users/me") return json(200, { data: ME });
    if (url.pathname.startsWith("/2/users/by/username/")) return json(200, { data: ME });
    if (url.pathname !== `/2/users/${ME.id}/tweets`) return json(404, { title: "Not Found" });

    const call = tweetCalls++;
    if (state.failOn?.calls.includes(call)) return json(state.failOn.status, { title: "Payment Required", detail: "No credits" });
    if (state.legacyOnly && url.searchParams.has("post.fields")) {
      return json(400, { title: "Invalid Request", detail: "The query parameter [post.fields] is not one of [...]" });
    }

    const p = url.searchParams;
    const since = p.get("since_id");
    const until = p.get("until_id");
    const start = p.get("start_time");
    const max = Number(p.get("max_results") ?? 10);
    const offset = Number(p.get("pagination_token") ?? 0);

    const matching = [...state.timeline]
      .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1))
      .filter((t) => (!since || BigInt(t.id) > BigInt(since)) && (!until || BigInt(t.id) < BigInt(until)))
      .filter((t) => !start || Date.parse(t.created_at!) >= Date.parse(start));
    const page = matching.slice(offset, offset + max);
    const next = offset + max < matching.length ? String(offset + max) : undefined;
    return json(200, {
      data: page.length ? page : undefined,
      meta: {
        result_count: page.length,
        newest_id: page[0]?.id,
        oldest_id: page.at(-1)?.id,
        next_token: next,
      },
    });
  }) as typeof fetch;
  return state;
}
