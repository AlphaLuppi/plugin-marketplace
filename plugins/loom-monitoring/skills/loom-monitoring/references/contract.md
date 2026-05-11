# Loom monitoring contract — full reference

Source of truth: `src/lib/loom-health.ts`, `src/workers/jobs/service-probe.ts`, `src/workers/jobs/frontend-version-check.ts`, `src/workers/jobs/heartbeat-watchdog.ts`, `src/app/api/heartbeat/[token]/route.ts`, `src/db/schema.ts`.

This document captures every detail the LLM needs to implement the contract correctly without reading the loom source.

---

## 1. `loom-health-v1` JSON contract

### Schema (TypeScript)

```ts
type HealthStatus = "pass" | "warn" | "fail";

type Check = {
  status: HealthStatus;
  componentType?: "datastore" | "system" | "component";
  observedValue?: unknown;
  observedUnit?: string;
  output?: string;
  time?: string;
};

type LoomHealthV1 = {
  status: HealthStatus;          // required
  serviceId: string;             // required, stable identifier
  time: string;                  // required, ISO 8601
  version?: string;              // recommended (npm_package_version)
  releaseId?: string;            // recommended (short git SHA)
  environment?: string;          // optional ("production" | "staging" | …)
  uptimeSeconds?: number;        // optional
  checks?: Record<string, Check[]>;
  notes?: string[];
  links?: Record<string, string>;
};
```

### HTTP rules

| Aggregate `status` | HTTP code | Notes |
|--------------------|-----------|-------|
| `pass`             | `200`     |       |
| `warn`             | `200`     | Loom records warn but does not return 503 |
| `fail`             | `503`     | Required — see `httpCodeForStatus` |

`Content-Type` should be `application/health+json` (Loom accepts `application/json` too).

### Aggregation rule

Implement this exactly when computing the top-level `status` from sub-checks (matches `aggregateChecksStatus` in `src/lib/loom-health.ts:49`):

```text
if any sub-check is "fail"  → "fail"
else if any sub-check is "warn" → "warn"
else                            → "pass"
```

### Soft vs hard sub-checks

A sub-check that should never bring the whole service down (e.g. an analytics ping) must self-cap at `warn`. Loom does this for its `claude_runtime` check: failure of the dependency yields `warn`, not `fail`. Pattern:

```ts
try {
  // probe the soft dependency
  checks.analytics = [{ status: "pass", componentType: "system" }];
} catch (e) {
  checks.analytics = [{ status: "warn", componentType: "system", output: String(e) }];
}
```

### Concrete payload

```json
{
  "status": "pass",
  "serviceId": "acme-api",
  "time": "2026-05-09T10:42:13.001Z",
  "version": "1.4.2",
  "releaseId": "abc1234",
  "environment": "production",
  "uptimeSeconds": 12034,
  "checks": {
    "postgres": [
      { "status": "pass", "componentType": "datastore", "observedValue": 3, "observedUnit": "ms" }
    ],
    "redis": [
      { "status": "pass", "componentType": "datastore" }
    ],
    "stripe_api": [
      { "status": "warn", "componentType": "component", "output": "elevated latency 800ms" }
    ]
  }
}
```

### Probe behavior in Loom (so contract decisions are predictable)

From `src/workers/jobs/service-probe.ts::probeLoomHealth`:
- Tick scheduler enqueues a `service-probe-tick` every 30 s; each tick scans services where `nextProbeAt <= now`.
- `nextProbeAt = lastProbeAt + intervalSec * 1000` with ±10% uniform jitter.
- Per-probe timeout = `service.timeoutMs` (default 5000 ms). Aborted via `AbortController`.
- Headers sent: `Accept: application/health+json, application/json`.
- HTTP `503` → `fail` regardless of body.
- Non-JSON body + 2xx → `pass` (legacy permissive parse). With `strictSchema=true` → `fail`.
- Invalid `status` field (anything other than the three enum values) → `fail`.
- Missing `releaseId` → recorded as a warning string but probe still passes.
- Missing `version` with `strictSchema=true` → warning recorded.

### Parser warnings

`parseHealthResponse` (`src/lib/loom-health.ts:98`) emits these `warnings` strings:
- `"missing-releaseId"` — `releaseId` absent.
- `"missing-version"` — `version` absent **only when** `strict=true`.

These are stored in `service_health_probes.error_message` as `"warnings: missing-releaseId,…"` for visibility.

---

## 2. `version-json` contract (CDN drift)

Used for static sites and CDN-served frontends. Pair with `loom-health-v1` on the upstream API.

### Endpoint

`GET /version.json` returning:

```json
{
  "commitSha": "abc1234567890def…",
  "buildTime": "2026-05-09T08:30:00Z",
  "version": "1.4.2"
}
```

`commitSha` is the only required field. `version` and `buildTime` are recommended. Use `Cache-Control: public, max-age=60` (matches `src/app/api/version.json/route.ts`).

### Drift detection (from `src/workers/jobs/frontend-version-check.ts`)

- If `expectedCommitSha` is empty on the service row → always `pass` (just records the served SHA).
- If served SHA = `expectedCommitSha` → `pass`.
- If mismatch and the correct SHA was served within the last hour → `warn` (drift just started).
- If mismatch ≥1 h → `warn` + `cdn-stale-version` alert (warning severity, deduped per service via `cdn-stale-version:<serviceId>`).
- If `commitSha` is missing in the response → `warn` with `errorMessage: "missing commitSha in /version.json"`.

The build pipeline must inject the SHA at build time. Loom does this via Docker build args:

```dockerfile
ARG LOOM_COMMIT_SHA=unknown
ARG LOOM_BUILD_TIME
ENV LOOM_COMMIT_SHA=$LOOM_COMMIT_SHA
ENV LOOM_BUILD_TIME=$LOOM_BUILD_TIME
```

```yaml
# CI snippet (any provider)
build-args: |
  LOOM_COMMIT_SHA=${{ github.sha }}
  LOOM_BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
```

When deploying a new build, **also update** `expectedCommitSha` on the service row (manual via UI today — the `/projects/<slug>/services/<id>` form).

---

## 3. `http-2xx` and `tcp-connect`

Trivial probes. Keep them as fallbacks only — they don't capture the per-dependency state Loom needs to be useful.

- `http-2xx`: GET `healthEndpoint`. Status = `pass` if `res.ok`, else `fail`. Latency recorded.
- `tcp-connect`: parse `healthEndpoint` as `host:port`, open a TCP socket with `service.timeoutMs`. Connect → `pass`; timeout/error → `fail`.

---

## 4. `heartbeat` contract

For services with no inbound HTTP (workers, crons, batch jobs).

### Token mint

Done by an operator in the Loom UI (`src/server/actions/heartbeats.ts::createHeartbeatToken`):
- Operator opens the service detail page → "Mint heartbeat token".
- Form takes `label` and `expectedIntervalSec` (30 ≤ … ≤ 86400).
- Plaintext token (`lh_<base64url>`) is shown **once** via a `?new=…` redirect param. Only its `sha256` hash is persisted.
- Token format check: starts with `lh_` and length ≥ `len("lh_") + 16`.

### POST endpoint

```
POST {LOOM_BASE_URL}/api/heartbeat/{token}
Content-Type: application/json
Body: optional JSON, ≤ 16 KiB
```

Example:

```bash
curl -fsS -X POST \
  -H 'Content-Type: application/json' \
  -d '{"jobsDone": 42, "lastError": null}' \
  "$LOOM_BASE_URL/api/heartbeat/$LOOM_HEARTBEAT_TOKEN"
```

Responses:
- `204 No Content` — beat recorded.
- `404 Not Found` — token unknown / revoked / service deleted (deliberately ambiguous; do not leak which).
- `429 Too Many Requests` — rate-limited (>1 req/sec from the same IP).

The receiver also inserts a `pass` row into `service_health_probes` so the heartbeat shows on the timeline alongside active probes.

### Watchdog (from `src/workers/jobs/heartbeat-watchdog.ts`)

- Runs every 60 s.
- For each non-revoked token: if `now - lastBeatAt > 2 * expectedIntervalSec * 1000`, raises `heartbeat-missing` alert (severity `critical`, deduped per token).
- When a beat lands again after a missing alert: auto-acks the open alert and emits `heartbeat-recovered` (severity `info`).

### Cadence guidance

Pick `expectedIntervalSec` ≥ the worst-case time between two real ticks of the worker. The watchdog only fires after `2×` that interval, so a 60 s cadence allows a 120 s blackout before paging. For very fast loops (every few seconds) clamp the actual POST cadence to once per minute or so to avoid hammering the receiver.

---

## 5. The `services` row — every field that matters

Schema: `src/db/schema.ts:522`. Fields the contract relies on:

| Column                | Type     | Notes                                                                |
|-----------------------|----------|----------------------------------------------------------------------|
| `name`                | text     | Unique per project                                                   |
| `type`                | enum     | `api | worker | cron | website | static | db | external`             |
| `lifecycle`           | enum     | `experimental | beta | production | deprecated` (default production)|
| `health_kind`         | enum     | The five values above                                                |
| `health_endpoint`     | text     | Full URL or `host:port` for `tcp-connect`                            |
| `version_endpoint`    | text     | For `version-json` and (optionally) `loom-health-v1`                 |
| `expected_commit_sha` | text     | Required for drift detection                                         |
| `interval_sec`        | int      | Default 60, min 30                                                   |
| `timeout_ms`          | int      | Default 5000, max 30000                                              |
| `strict_schema`       | bool     | When ON: non-JSON body or invalid status → `fail`                    |
| `enabled`             | bool     | Disabled services are skipped                                        |
| `slo_availability_pct`| numeric  | Reporting only                                                       |
| `slo_latency_p95_ms`  | int      | Reporting only                                                       |

Side-tables:
- `service_health_probes` — append-only probe history (vacuumed daily).
- `heartbeat_tokens` — `token_hash`, `expected_interval_sec`, `last_beat_at`.
- `service_dependencies` — graph between services for blast-radius views.

---

## 6. Alerting & dedupe (so noise stays bounded)

From `src/lib/service-probe.ts::transitionAlerts`:

| Transition          | Alert kind            | Severity | Dedupe key                          |
|---------------------|-----------------------|----------|-------------------------------------|
| `* → fail`          | `service-down`        | critical | `service-down:<serviceId>`          |
| `* → warn`          | `service-degraded`    | warning  | `service-degraded:<serviceId>`      |
| `fail|warn → pass`  | `service-recovered`   | info     | `service-recovered:<id>:<ts>` (auto-ack) |
| version drift ≥1 h  | `cdn-stale-version`   | warning  | `cdn-stale-version:<serviceId>`     |
| heartbeat stale     | `heartbeat-missing`   | critical | `heartbeat-missing:<tokenId>`       |

`service-down` and `service-degraded` only insert if no open (unacked) alert with the same dedupe key already exists — so flapping does not spam Discord.

The first probe ever, when `pass`, **does not** raise a recovered alert (no prior state).

---

## 7. Implementation patterns

See `examples.md` for ready-to-paste snippets in Express, Fastify, Next.js App Router, Bun, FastAPI, plus a heartbeat worker.
