# Loom monitoring — implementation snippets

Ready-to-paste examples per stack. All emit the `loom-health-v1` JSON shape and use the aggregation rule from `contract.md`. Replace `serviceId`, sub-checks, and `releaseId` source for your app.

---

## Shared helper (TypeScript, framework-agnostic)

Drop this in `lib/loom-health.ts`. It mirrors `src/lib/loom-health.ts` from this repo, minus types unrelated to building responses.

```ts
export type HealthStatus = "pass" | "warn" | "fail";

export type Check = {
  status: HealthStatus;
  componentType?: "datastore" | "system" | "component";
  observedValue?: unknown;
  observedUnit?: string;
  output?: string;
};

export function aggregateStatus(statuses: HealthStatus[]): HealthStatus {
  if (statuses.includes("fail")) return "fail";
  if (statuses.includes("warn")) return "warn";
  return "pass";
}

export function httpCodeForStatus(s: HealthStatus): 200 | 503 {
  return s === "fail" ? 503 : 200;
}

export function buildBody(input: {
  serviceId: string;
  checks: Record<string, Check[]>;
  version?: string;
  releaseId?: string;
  environment?: string;
}) {
  const top: Record<string, HealthStatus> = {};
  for (const [k, v] of Object.entries(input.checks)) {
    top[k] = aggregateStatus(v.map((c) => c.status));
  }
  const status = aggregateStatus(Object.values(top));
  return {
    body: {
      status,
      serviceId: input.serviceId,
      time: new Date().toISOString(),
      ...(input.version ? { version: input.version } : {}),
      ...(input.releaseId ? { releaseId: input.releaseId } : {}),
      ...(input.environment ? { environment: input.environment } : {}),
      uptimeSeconds: Math.round(process.uptime()),
      checks: input.checks,
    },
    httpStatus: httpCodeForStatus(status),
  };
}
```

---

## Express

```ts
import express from "express";
import { Pool } from "pg";
import { buildBody, type Check } from "./lib/loom-health";

const app = express();
const pg = new Pool({ connectionString: process.env.DATABASE_URL });

app.get("/health", async (_req, res) => {
  const checks: Record<string, Check[]> = {};

  const t0 = Date.now();
  try {
    await pg.query("select 1");
    checks.postgres = [{
      status: "pass",
      componentType: "datastore",
      observedValue: Date.now() - t0,
      observedUnit: "ms",
    }];
  } catch (e) {
    checks.postgres = [{ status: "fail", componentType: "datastore", output: String(e) }];
  }

  const { body, httpStatus } = buildBody({
    serviceId: "acme-api",
    version: process.env.npm_package_version,
    releaseId: process.env.GIT_COMMIT_SHA?.slice(0, 8),
    environment: process.env.NODE_ENV,
    checks,
  });
  res.status(httpStatus).type("application/health+json").send(body);
});
```

---

## Next.js App Router

```ts
// app/api/health/route.ts
import { buildBody, type Check } from "@/lib/loom-health";
import { db } from "@/db/client";
import { sql } from "drizzle-orm";

export async function GET() {
  const checks: Record<string, Check[]> = {};

  try {
    const t0 = Date.now();
    await db.execute(sql`select 1`);
    checks.postgres = [{
      status: "pass",
      componentType: "datastore",
      observedValue: Date.now() - t0,
      observedUnit: "ms",
    }];
  } catch (e) {
    checks.postgres = [{ status: "fail", componentType: "datastore", output: String(e) }];
  }

  const { body, httpStatus } = buildBody({
    serviceId: "acme-api",
    version: process.env.npm_package_version,
    releaseId: process.env.LOOM_RELEASE_ID,
    environment: process.env.NODE_ENV,
    checks,
  });
  return Response.json(body, {
    status: httpStatus,
    headers: { "Content-Type": "application/health+json" },
  });
}
```

For separate `live`/`ready` probes (k8s-style), mirror Loom's pattern in `src/app/api/health/live/route.ts` and `ready/route.ts`:
- `live` does no I/O; flips to 503 on `SIGTERM` so load balancers drain.
- `ready` pings DB+Redis, cached 5 s in-process.

---

## Fastify

```ts
import Fastify from "fastify";
import { buildBody, type Check } from "./lib/loom-health";

const app = Fastify();

app.get("/health", async (_req, reply) => {
  const checks: Record<string, Check[]> = {
    self: [{ status: "pass", componentType: "system" }],
  };
  const { body, httpStatus } = buildBody({
    serviceId: "acme-worker",
    releaseId: process.env.GIT_COMMIT_SHA,
    checks,
  });
  reply
    .code(httpStatus)
    .header("content-type", "application/health+json")
    .send(body);
});
```

---

## Bun (no framework)

```ts
import { buildBody } from "./lib/loom-health";

Bun.serve({
  port: 3000,
  fetch(req) {
    if (new URL(req.url).pathname !== "/health") return new Response("not found", { status: 404 });
    const { body, httpStatus } = buildBody({
      serviceId: "acme-bun",
      releaseId: Bun.env.GIT_COMMIT_SHA,
      checks: { self: [{ status: "pass", componentType: "system" }] },
    });
    return Response.json(body, {
      status: httpStatus,
      headers: { "Content-Type": "application/health+json" },
    });
  },
});
```

---

## Python (FastAPI)

```python
import os, time
from datetime import datetime, timezone
from fastapi import FastAPI, Response
from fastapi.responses import JSONResponse

app = FastAPI()
START = time.time()

def aggregate(statuses):
    if "fail" in statuses: return "fail"
    if "warn" in statuses: return "warn"
    return "pass"

@app.get("/health")
async def health():
    checks = {}
    try:
        # replace with real DB ping
        t0 = time.time()
        # await db.execute("select 1")
        checks["postgres"] = [{
            "status": "pass",
            "componentType": "datastore",
            "observedValue": int((time.time() - t0) * 1000),
            "observedUnit": "ms",
        }]
    except Exception as e:
        checks["postgres"] = [{"status": "fail", "componentType": "datastore", "output": str(e)}]

    top = [aggregate([c["status"] for c in v]) for v in checks.values()]
    status = aggregate(top)
    body = {
        "status": status,
        "serviceId": "acme-py",
        "time": datetime.now(timezone.utc).isoformat(),
        "version": os.environ.get("APP_VERSION"),
        "releaseId": os.environ.get("GIT_COMMIT_SHA"),
        "environment": os.environ.get("ENV"),
        "uptimeSeconds": int(time.time() - START),
        "checks": checks,
    }
    code = 503 if status == "fail" else 200
    return JSONResponse(body, status_code=code, media_type="application/health+json")
```

---

## `/version.json` (CDN drift)

### Static build (Next.js / Vite / etc.)

Inject the SHA and build time at build with env vars or build args, then emit a static JSON or a tiny route:

```ts
// app/version.json/route.ts (Next.js App Router)
export async function GET() {
  return Response.json(
    {
      commitSha: process.env.GIT_COMMIT_SHA ?? "unknown",
      buildTime: process.env.BUILD_TIME ?? null,
      version: process.env.npm_package_version ?? "unknown",
    },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
```

### Dockerfile fragment

```dockerfile
ARG GIT_COMMIT_SHA=unknown
ARG BUILD_TIME
ENV GIT_COMMIT_SHA=$GIT_COMMIT_SHA
ENV BUILD_TIME=$BUILD_TIME
```

### CI fragment (GitHub Actions)

```yaml
- name: Build image
  run: |
    docker build \
      --build-arg GIT_COMMIT_SHA=${{ github.sha }} \
      --build-arg BUILD_TIME=$(date -u +"%Y-%m-%dT%H:%M:%SZ") \
      -t myapp:${{ github.sha }} .
```

When deploying a new build, also update `expectedCommitSha` on the Loom service row.

---

## Heartbeat from a worker

### Bare Node/TS

```ts
// heartbeat.ts
const TOKEN = process.env.LOOM_HEARTBEAT_TOKEN;
const BASE  = process.env.LOOM_BASE_URL ?? "https://loom.example.com";

export async function beat(payload?: Record<string, unknown>) {
  if (!TOKEN) return;
  try {
    await fetch(`${BASE}/api/heartbeat/${TOKEN}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: payload ? JSON.stringify(payload) : undefined,
      signal: AbortSignal.timeout(2000),
    });
  } catch {
    // never crash the worker on a heartbeat failure
  }
}
```

### BullMQ worker integration

```ts
import { Worker } from "bullmq";
import { beat } from "./heartbeat";

const w = new Worker("my-queue", async (job) => {
  // … do work
});

w.on("completed", (job) => beat({ jobId: job.id, kind: "completed" }));
w.on("failed",    (job, err) => beat({ jobId: job?.id, kind: "failed", err: err.message }));

// And a steady drumbeat independent of job activity:
setInterval(() => beat({ alive: true }), 60_000);
```

### Cron / shell

```bash
#!/usr/bin/env bash
set -euo pipefail
: "${LOOM_HEARTBEAT_TOKEN:?required}"
: "${LOOM_BASE_URL:?required}"

curl -fsS --max-time 2 -X POST \
  -H 'Content-Type: application/json' \
  -d "{\"finishedAt\":\"$(date -u +%FT%TZ)\"}" \
  "$LOOM_BASE_URL/api/heartbeat/$LOOM_HEARTBEAT_TOKEN" \
  > /dev/null
```

Set `expectedIntervalSec` on the Loom token to the cron's worst case.

---

## Sub-check examples

```ts
// Redis
const t0 = Date.now();
try {
  await redis.ping();
  checks.redis = [{ status: "pass", componentType: "datastore", observedValue: Date.now() - t0, observedUnit: "ms" }];
} catch (e) {
  checks.redis = [{ status: "fail", componentType: "datastore", output: String(e) }];
}

// Soft third-party (never brings the service down)
try {
  const r = await fetch("https://api.thirdparty.com/health", { signal: AbortSignal.timeout(1500) });
  checks.thirdparty = [{ status: r.ok ? "pass" : "warn", componentType: "component", output: `http ${r.status}` }];
} catch {
  checks.thirdparty = [{ status: "warn", componentType: "component", output: "unreachable" }];
}

// Disk space (warn over 80%, fail over 95%)
import { statfs } from "node:fs/promises";
const s = await statfs("/data");
const usedPct = 1 - (s.bavail / s.blocks);
checks.disk = [{
  status: usedPct > 0.95 ? "fail" : usedPct > 0.80 ? "warn" : "pass",
  componentType: "system",
  observedValue: Math.round(usedPct * 100),
  observedUnit: "percent",
}];
```
