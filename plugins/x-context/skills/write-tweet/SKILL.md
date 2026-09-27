---
name: write-tweet
description: Draft X (Twitter) posts and threads grounded in my own posting history and in what has measurably performed for me. Use when I ask to write, draft, rewrite, brainstorm or critique a tweet, an X post or a thread, ask "what should I tweet about X", or want to know what works on my account. Relies on the x-context MCP tools (x_writing_context, x_list_posts, x_sync). Never publishes anything.
---

# Write my next X post from my own data

The x-context MCP server caches my X posts with their metrics. Reading the cache is free; `x_sync` calls the paid X API (billed per post read). Use the data to decide *what* to write and *in which shape*; use my voice to decide *how it sounds*.

## 1. Load the context

1. Call `x_writing_context` (defaults are fine; pass `lang` when I clearly write this post in one language and my history mixes several).
2. Read its first lines:
   - **"Never synced"** → run `x_sync` with `dry_run: true`, tell me the auth mode and the worst-case cost it prints, and wait for my go before the real `x_sync`. After that, one `x_sync` with `mode: "backfill"` fetches older history if the context feels thin (< 30 original posts).
   - **"stale"** → run `x_sync` (mode `"new"`, default `max_posts`) without asking: it only reads posts newer than the cache, usually a few cents at most. Then reload the context.
   - **Unsettled metrics** mentioned → add `refresh_metrics_days: 7` to that sync.
   - **Config problems** → stop and tell me exactly which setting is missing (plugin settings: `/plugin` → x-context → configure).
3. If a sync returns an error (402 = credits/spend cap, 401 = keys, 429 = rate limit), report it verbatim and keep going with the cached data if there is any.

## 2. Pin down the brief

From my request, settle: topic, goal (conversation, reach, profile visits, clicks), format (single post, thread, quote, long post), language. Ask one short question only if the topic itself is missing.

## 3. Check what I already said

Call `x_list_posts` with 1–3 keywords of the topic (`kind: "all"`, `limit: 10`). If I already covered it:
- say so and link the post(s);
- only propose a new angle, an update, or an explicit follow-up — never a paraphrase.

Also scan the "Most recent posts" section: don't reuse a recent opener, structure or punchline.

## 4. Apply my voice

If a personal voice skill is available (for example one named `*-writing-style`), load it and follow it — it wins over any pattern below. Otherwise infer the voice from my top and recent posts: sentence length, casing, punctuation, line breaks, emoji and hashtag habits, language, how I open and close.

Don't import generic "growth" tropes I don't use: no "🧵" or "1/8", no hashtag stuffing, no "RT if you agree", no emoji unless my posts have them (see the `% emoji` / `% hashtags` numbers).

## 5. Use the numbers honestly

- Rank by **×usual** (engagement vs. my own median at the time), not raw likes: my audience changed over time.
- A bucket with 3–5 posts is a hint, not a law. Say "weak signal" when n is small or when the gap between buckets is < ~1.3×.
- One viral outlier is not a format. Look for patterns across several top posts (structure, length, opener type, question vs. statement, media).
- The weakest posts show what to avoid; name the pattern if there is one.

## 6. Deliver

Give **3 drafts** that differ in angle or format, not just wording. For each:

```
### Draft A — <angle in 3–6 words>
<the post, exactly as it would be published; for a thread, each post separated by a line with ---> 

<N> chars · format: <single / thread of N / long post> · best slot: <weekday + hour block, only if the data supports it>
Why: <one or two lines tied to the data — e.g. "multi-line 101–200 char posts run ×2.1 vs usual; mirrors the structure of <link to my post>">
```

Character counts: X counts every URL as 23 characters. Stay ≤ 280 per post unless my history shows long posts (`>280 chars` / `long post` buckets) and they perform.

Finish with one line recommending which draft to post and why. If I shared my own draft instead, critique it against the same data first, then propose an improved version plus one alternative angle.

Never post, schedule or send anything: this plugin is read-only, I publish myself.
