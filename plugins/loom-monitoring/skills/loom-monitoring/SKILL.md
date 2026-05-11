---
name: loom-monitoring
description: Make any application monitorable by Loom — bring an app, worker, cron, website, or external service into compliance with Loom's health/heartbeat contract so it can be registered as a `service` and probed automatically. Use this skill when a user wants their app to appear on a Loom project dashboard with uptime/version drift/heartbeat alerts. Covers the loom-health-v1 JSON contract, /version.json drift detection, heartbeat tokens, and registration steps.
---

# Loom monitoring — make an app probe-able by Loom

Loom probes registered services on a fixed cadence (default 30s tick, per-service `intervalSec`, ±10% jitter) and raises alerts on transitions between `pass`/`warn`/`fail`. This skill walks an LLM through bringing **any** target application up to Loom's contract.

The canonical implementation lives in this repo and should be treated as ground truth:
- Contract types/parser: `src/lib/loom-health.ts`
- Loom's own probe endpoints: `src/app/api/health/{route.ts,live/route.ts,ready/route.ts}` and `src/app/api/version.json/route.ts`
- Probe worker: `src/workers/jobs/service-probe.ts`
- Heartbeat receiver: `src/app/api/heartbeat/[token]/route.ts`
- Heartbeat watchdog: `src/workers/jobs/heartbeat-watchdog.ts`
- DB schema: `src/db/schema.ts` (`services`, `serviceHealthProbes`, `heartbeatTokens`)

## Step 1 — Pick the right `health_kind`

| `health_kind`     | What Loom does                                          | Best for                              |
|-------------------|---------------------------------------------------------|---------------------------------------|
| `loom-health-v1`  | GET JSON, parses `status` + sub-checks                  | HTTP services we own (**default**)    |
| `version-json`    | GET JSON, compares `commitSha` to `expectedCommitSha`   | Static sites / CDN-served frontends   |
| `http-2xx`        | GET, expects 2xx                                        | Third-party APIs we don't control     |
| `tcp-connect`     | TCP connect to `host:port`                              | Databases, raw TCP services           |
| `heartbeat`       | App POSTs to Loom on a cadence (passive probe)          | Workers/crons with no inbound HTTP    |

Decision rule for the LLM:
1. App accepts inbound HTTP **and** we control the code → `loom-health-v1`.
2. Frontend served via CDN where staleness matters → `version-json` (often paired with `loom-health-v1` on a separate API service).
3. App is a worker/cron/job runner with no listener → `heartbeat`.
4. Third-party with no JSON contract → `http-2xx`.
5. Bare TCP daemon (Postgres, Redis, custom) → `tcp-connect`.

## Step 2 — Implement the contract

For `loom-health-v1` (the strongly-recommended path), the response must satisfy:
- HTTP `200` for `pass`/`warn`, HTTP `503` for `fail` (use `httpCodeForStatus` in `src/lib/loom-health.ts:45`).
- `Content-Type: application/health+json` (or `application/json`).
- JSON object with **required** `status` (`"pass" | "warn" | "fail"`), `serviceId`, `time` (ISO 8601). **Recommended**: `releaseId` (short git SHA), `version`, `environment`, `uptimeSeconds`, `checks`.
- Aggregate sub-check status with the rule: any `fail` → `fail`; else any `warn` → `warn`; else `pass` (`aggregateChecksStatus`, `src/lib/loom-health.ts:49`).

Probe edge cases (so the implementation matches Loom's expectations):
- HTTP `503` → `fail` regardless of body.
- Non-JSON body + 2xx → `pass` (legacy behavior) **unless** the service is registered with `strictSchema=true`, then `fail`. Always emit valid JSON.
- Invalid `status` field → always `fail`.
- Default `timeoutMs` = 5000; min `intervalSec` = 30.

For full spec, every parser warning, all five health kinds, end-to-end example payloads, alerting/dedupe behavior, and the heartbeat token flow → read `references/contract.md`.

For copy-paste implementations (Express, Next.js App Router, Fastify, Bun, Python FastAPI, plus a `/version.json` builder and a heartbeat worker) → read `references/examples.md`.

For the full MCP registration tool reference (every input field, error modes, two worked examples) → read `references/mcp-registration.md`.

## Step 3 — Register the service in Loom (via MCP)

Loom prod exposes its registration API as MCP tools (server name `loom`). When the user has the Loom MCP attached to Claude Code (`.mcp.json` entry pointing at `https://<loom-host>/api/mcp` with a write-scope bearer token), the agent should drive the whole flow without sending the user to the UI.

**Prerequisites the agent should verify before calling any tool:**
1. The Loom MCP server is reachable — call `mcp__loom__loom.ping` (zero-arg sanity).
2. The target project exists and is accessible — call `mcp__loom__loom.get_project({ idOrSlug: "<slug>" })`. If it 404s, refuse to proceed (do NOT auto-create projects from this skill).
3. The token has `write` scope — `loom.ping` returns the scopes; abort with a clear message if `write` is missing.

**Idempotent registration flow:**

1. **Check existing.** `mcp__loom__loom.list_services({ project: "<slug>" })`. If a row with the planned `name` exists, route to step 3 (update path).
2. **Create.** `mcp__loom__loom.add_service({ project, name, type, healthKind, healthEndpoint?, versionEndpoint?, expectedCommitSha?, intervalSec?, timeoutMs?, strictSchema?, enabled?, lifecycle?, description?, repoId?, vpsId?, runbookWikiPath?, sloAvailabilityPct?, sloLatencyP95Ms?, links? })`. Throws if `(project, name)` already exists — catch and switch to update.
3. **Update / re-sync.** `mcp__loom__loom.update_service({ project, name, patch: { … } })` for any changed field. For drift detection after each deploy, prefer the convenience tool: `mcp__loom__loom.set_expected_commit_sha({ project, name, sha })`.
4. **Heartbeat (only if `healthKind === "heartbeat"`).** `mcp__loom__loom.create_heartbeat_token({ project, name, label, expectedIntervalSec })` returns `{ token: "lh_…", warning }`. The plaintext is shown ONCE — write it immediately to the watched app's env (typically `LOOM_HEARTBEAT_TOKEN`) and never echo it back into the conversation. To rotate, mint a new one then call `mcp__loom__loom.revoke_heartbeat_token({ project, name, tokenId })` on the old.
5. **Activate.** `add_service` defaults `enabled=true`. Use `mcp__loom__loom.disable_service` / `enable_service` for planned maintenance windows.
6. **Smoke-test.** `mcp__loom__loom.probe_now({ project, name })` enqueues an immediate probe; poll `mcp__loom__loom.get_service({ project, name })` and read `lastStatus` / `lastProbeAt` (the tool returns the service row plus its active heartbeat-token metadata, never plaintext).

**MCP tool reference (added in this branch):**

| Tool                                | Scope | Purpose                                                              |
|-------------------------------------|-------|----------------------------------------------------------------------|
| `loom.list_services`                | read  | List services for a project (idempotence check)                      |
| `loom.get_service`                  | read  | Single service + active heartbeat-token metadata                     |
| `loom.add_service`                  | write | Register; throws on `(project, name)` conflict                       |
| `loom.update_service`               | write | Patch (no rename — UI only)                                          |
| `loom.set_expected_commit_sha`      | write | Convenience for post-deploy drift sync                               |
| `loom.enable_service` / `disable_service` | write | Toggle `enabled`; returns `{ changed: bool }` for cron-safe re-runs |
| `loom.probe_now`                    | write | Enqueue immediate probe; does not wait for result                    |
| `loom.create_heartbeat_token`       | write | Mint; plaintext returned **once**                                    |
| `loom.revoke_heartbeat_token`       | write | Revoke by `tokenId`                                                  |

**Manual fallback (no MCP attached).** If the agent can't reach the Loom MCP, fall back to the Loom UI: navigate to the target project → `Services → Nouveau service` → fill the same fields documented above. The DB row that backs this is `services` in `src/db/schema.ts:522`.

## Step 4 — Verify

Two complementary checks; run both when possible.

**(a) Local parser check** (no Loom round-trip — sanity-checks the contract before the URL is even reachable from prod):

```bash
./scripts/verify.sh https://api.example.com/health
```

It curls the endpoint, parses the response with the same rules Loom's probe uses, prints what status Loom would record, and lists any warnings (`missing-releaseId`, `invalid-status`, etc.).

**(b) End-to-end Loom probe** (after registration, when the MCP is available):

```text
mcp__loom__loom.probe_now({ project, name })
# wait ~2s
mcp__loom__loom.get_service({ project, name })  # read .service.lastStatus
```

A `lastStatus: "pass"` confirms Loom's probe worker can reach the endpoint AND parse it — the strongest signal that registration succeeded.

## Hand-off summary to give back to the user

After applying this skill, summarise to the user:
1. Which `health_kind` was chosen and why.
2. The exact path/URL of the new endpoint(s).
3. The `releaseId` source (build arg / env var) and how to keep it fresh.
4. Any sub-checks added and whether each contributes `fail` or only `warn` to the aggregate.
5. The recommended `intervalSec`/`timeoutMs` and whether `strictSchema` should be ON.
6. For heartbeat: the env var name set on the watched app, and the cadence (must be ≤ `expectedIntervalSec`).
7. The Loom service id returned by `add_service` and the result of the verification probe (`lastStatus`).
