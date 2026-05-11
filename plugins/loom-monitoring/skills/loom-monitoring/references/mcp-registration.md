# Loom MCP — service registration reference

Detailed reference for the MCP tools the `loom-monitoring` skill drives. Source of truth: `src/lib/mcp/tools-read.ts` and `src/lib/mcp/tools-write.ts` in the loom repo.

## Connection model

- Server name: **`loom`** (from `src/lib/mcp/server.ts`).
- Transport: HTTP MCP at `https://<loom-host>/api/mcp` with `Authorization: Bearer lm_…` (token format documented in `src/lib/mcp/auth.ts`).
- Auth chain: token must be non-revoked, ≤365d old, owned by a user still in `user_whitelist`, with a stored GitHub OAuth artifact. Failures return 401 without distinguishing the cause.
- Scopes: tools tagged `read` need `read` (or `admin`); tools tagged `write` need `write` (or `admin`). `requireScope` is enforced *inside each handler*, not just at registration — never trust the registry alone.

When the Loom MCP is attached to Claude Code, tool names appear as `mcp__loom__loom.<name>`.

## Tool reference

### `loom.ping` (read)

Zero-arg sanity check. Returns `{ ok: true, scopes: [...] }`. Use to verify both transport and the token's scopes before attempting writes.

### `loom.get_project({ idOrSlug })` (read)

Same surface as the rest of Loom — accepts either UUID or slug. Returns `null`/throws `Project … not found` if missing. **Use first** to confirm the target project exists; this skill never auto-creates projects.

### `loom.list_services({ project })` (read)

Returns every service row for the project. Use for idempotence: before calling `add_service`, check whether `name` is already present.

### `loom.get_service({ project, name })` (read)

Returns `{ service: <row>, heartbeatTokens: [{ id, label, expectedIntervalSec, lastBeatAt, createdAt }] }`. Plaintext is **never** included — heartbeat tokens are zero-knowledge after mint. Use to:
- Read `lastStatus` / `lastProbeAt` after `probe_now` (verification).
- Discover existing heartbeat token ids before calling `revoke_heartbeat_token`.

### `loom.add_service({ project, name, type, ... })` (write)

Required fields:
- `project` — UUID or slug.
- `name` — unique within project (DB unique index `services_project_name_unique`).
- `type` — one of `api | worker | cron | website | static | db | external`.

All other fields are optional with these defaults:

| Field                  | Default            |
|------------------------|--------------------|
| `lifecycle`            | `production`       |
| `healthKind`           | `loom-health-v1`   |
| `intervalSec`          | `60`               |
| `timeoutMs`            | `5000`             |
| `strictSchema`         | `false`            |
| `enabled`              | `true`             |

Optional structured fields: `description`, `repoId` (UUID of an attached repo from `loom.list_repos`), `vpsId` (UUID from `loom.list_vps`), `runbookWikiPath`, `healthEndpoint`, `versionEndpoint`, `expectedCommitSha`, `sloAvailabilityPct` (0–100), `sloLatencyP95Ms`, `links` (object — UI flow accepts a multiline `key=value` string and parses it; the MCP surface skips that ceremony).

**Idempotence:** throws `Service "<name>" already exists in project <slug> (id=<uuid>). Use loom.update_service to modify it.` on conflict. Always catch this and switch to `update_service`.

**Returns:** the inserted service row, including the new `id`.

### `loom.update_service({ project, name, patch })` (write)

`patch` is a partial of every field on `add_service` except `name`. Cannot rename — the `(project, name)` lookup key is the same as the value being changed. Use the web UI for renames.

Sparse semantics: only forwards keys the caller actually sent. Passing `patch.intervalSec = undefined` is the same as omitting it (no-op for that field). Passing `patch.expectedCommitSha = ""` does **not** clear it — use `set_expected_commit_sha` with an empty string for that.

### `loom.set_expected_commit_sha({ project, name, sha })` (write)

Convenience over `update_service` for the post-deploy drift-sync step. Empty string clears (disables drift detection). CI usage:

```bash
# After a successful deploy in app foo
curl -sS -X POST https://loom/api/mcp \
  -H "Authorization: Bearer $LOOM_MCP_TOKEN" \
  ...   # MCP envelope, tool=loom.set_expected_commit_sha,
        # args={ project: "foo", name: "foo-api", sha: "$GITHUB_SHA" }
```

### `loom.enable_service` / `loom.disable_service({ project, name })` (write)

Toggle the `enabled` boolean. Both no-op if already in the desired state, returning `{ changed: false }` so cron-driven callers (e.g. `disable while running migrations, then re-enable`) can tell whether they actually flipped anything.

### `loom.probe_now({ project, name })` (write)

Enqueues a `service-probe` BullMQ job with `force: true` and a timestamped `jobId` (so multiple manual probes during a debug session don't dedupe). Returns synchronously — the probe runs asynchronously. Poll `loom.get_service` to read the result.

### `loom.create_heartbeat_token({ project, name, label, expectedIntervalSec })` (write)

Mints a token. Returns:

```json
{
  "id": "<uuid>",
  "serviceId": "<uuid>",
  "label": "<label>",
  "expectedIntervalSec": 300,
  "token": "lh_<base64url>",
  "warning": "Plaintext shown once; not retrievable later."
}
```

The plaintext is the bearer the watched app POSTs to `/api/heartbeat/<token>`. Server only stores `sha256(token)`. The skill should:

1. Capture `token` immediately.
2. Write it to the watched app's environment (typically `LOOM_HEARTBEAT_TOKEN`) — through whatever deployment surface the app uses (`.env.production`, `kubectl set env`, fly secrets, Vercel env, etc.).
3. **Never echo the plaintext back** in chat output.
4. Record the `id` for future revocation.

`expectedIntervalSec` is the watchdog window — the heartbeat-watchdog worker raises an alert after `2 × expectedIntervalSec` of silence. Set it to ≥ the worker's beat cadence with a safety margin.

### `loom.revoke_heartbeat_token({ project, name, tokenId })` (write)

Soft-delete (sets `revoked_at`). The tool refuses if:
- `tokenId` doesn't exist
- `tokenId` is already revoked
- `tokenId` belongs to a different service than `(project, name)` resolves to

Use to rotate: mint a new token, switch the env, then revoke the old.

## Worked example: heartbeat worker

```text
1. mcp__loom__loom.ping                    → { ok, scopes: ["write"] }
2. mcp__loom__loom.get_project({ idOrSlug: "casa-mia" })
3. mcp__loom__loom.list_services({ project: "casa-mia" })
   → no row named "casa-mia-billing-cron"
4. mcp__loom__loom.add_service({
     project: "casa-mia",
     name: "casa-mia-billing-cron",
     type: "cron",
     healthKind: "heartbeat",
     intervalSec: 60,        # cadence at which the watchdog re-evaluates
     description: "Nightly billing reconciliation"
   })
   → { id: "abc-…", … }
5. mcp__loom__loom.create_heartbeat_token({
     project: "casa-mia",
     name: "casa-mia-billing-cron",
     label: "prod",
     expectedIntervalSec: 90000   # nightly job ⇒ ~25h watchdog
   })
   → { id: "tok-…", token: "lh_xxxx", warning: "..." }
6. (skill writes lh_xxxx to the cron's env, never echoes it)
7. (skill modifies the cron to POST /api/heartbeat/${LOOM_HEARTBEAT_TOKEN} on each run)
8. (operator runs the cron once; watchdog now sees a recent beat)
9. mcp__loom__loom.get_service({ project: "casa-mia", name: "casa-mia-billing-cron" })
   → heartbeatTokens[0].lastBeatAt ≈ now ✓
```

## Worked example: HTTP API with version drift

```text
1. mcp__loom__loom.add_service({
     project: "casa-mia",
     name: "casa-mia-api",
     type: "api",
     healthKind: "loom-health-v1",
     healthEndpoint: "https://api.casa-mia.example/health",
     versionEndpoint: "https://api.casa-mia.example/version.json",
     intervalSec: 60,
     timeoutMs: 5000,
     strictSchema: true,
     sloAvailabilityPct: 99.9,
     sloLatencyP95Ms: 500
   })
2. (CI deploys; build pipeline runs:)
   mcp__loom__loom.set_expected_commit_sha({
     project: "casa-mia",
     name: "casa-mia-api",
     sha: "$GITHUB_SHA"
   })
3. mcp__loom__loom.probe_now({ project: "casa-mia", name: "casa-mia-api" })
4. (poll)
   mcp__loom__loom.get_service({ project: "casa-mia", name: "casa-mia-api" })
   → service.lastStatus === "pass"
```
