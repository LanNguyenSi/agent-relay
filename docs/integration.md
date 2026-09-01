# Integration

How the relay is consumed: by [deploy-panel](https://github.com/LanNguyenSi/deploy-panel) and similar UIs over the HTTP API, by Claude Code and other AI agents over MCP, and what each app on the VPS needs to ship in its `.relay.yml`.

## `.relay.yml` config reference

Place a `.relay.yml` at the root of each app under `APPS_DIR`:

```yaml
# Required
name: my-app
health: /api/health

# Optional
compose_file: docker-compose.yml    # default: docker-compose.yml
command: make deploy                # overrides default git pull + compose flow
pre_update:                         # commands to run before deploy
  - make db-generate
post_update:                        # commands to run after deploy
  - docker compose exec backend npx prisma migrate deploy
rollback: true                      # auto-rollback on health check failure (default: true)
# step_timeout_seconds: 600          # per-step exec timeout override (default: 300)
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | App identifier |
| `health` | `string` | Yes | -- | Health check endpoint path (e.g. `/api/health`) |
| `compose_file` | `string` | No | `docker-compose.yml` | Docker Compose file name. Must match `[A-Za-z0-9._/-]+`. Passed as a literal `docker compose` argument (never shell-interpolated); rejected only if it resolves outside `APPS_DIR`, so sibling-app paths like `../other-app/docker-compose.yml` are allowed. |
| `command` | `string` | No | -- | Custom deploy command (replaces default git+compose flow). **Arbitrary shell.** |
| `pre_update` | `string[]` | No | `[]` | Commands to run before the deploy. **Arbitrary shell.** |
| `post_update` | `string[]` | No | `[]` | Commands to run after compose up. **Arbitrary shell.** |
| `health_port` | `number` | No | -- | Port for health check requests (if different from Traefik-routed port) |
| `rollback` | `boolean` | No | `true` | Auto-rollback to previous commit on failure |
| `step_timeout_seconds` | `integer` | No | `300` | Per-step exec timeout, in seconds (1-7200). Applies to `pre_update`, `git pull`, `compose build`/`up`, `post_update`, `command`, and rollback `compose build`/`up`. A step killed by this timeout, or by the fixed 64 MB combined stdout/stderr buffer cap, carries a `[relay] ...` reason line appended to its output. |

The shell-exec fields (`command`, `pre_update`, `post_update`) cross a real trust boundary: see [docs/security.md](security.md).

## HTTP API

All `/api` endpoints require `Authorization: Bearer <AUTH_TOKEN>` unless noted otherwise. Base path: `/api`.

### `GET /health`

Public relay health check. **No authentication required.** Returns status and version but does not include uptime. Useful for external uptime monitors and load balancer probes. `version` is the running relay's `package.json` version, read dynamically at startup.

```json
{ "status": "ok", "version": "<version>" }
```

### `GET /api/health`

Authenticated relay health check. Same as `/health` but includes server uptime.

```json
{ "status": "ok", "version": "<version>", "uptime": 12345.67 }
```

### `GET /api/system`

Server resource metrics (CPU, memory, disk). `cpu.usage` and `memory.*Mb` are numbers; the `disk` fields are the raw `df -h` strings (size/used carry unit suffixes, `percent` includes the `%`).

```json
{
  "cpu": { "usage": 23.5 },
  "memory": { "usedMb": 4096, "totalMb": 8192 },
  "disk": { "used": "42G", "total": "100G", "percent": "42%" },
  "uptime": 12345.67
}
```

### `GET /api/apps`

List all apps in `APPS_DIR` with config status and current commit.

```json
{
  "apps": [
    { "name": "my-app", "configured": true, "health": "/api/health", "commit": "abc1234" },
    { "name": "other-app", "configured": false }
  ]
}
```

### `GET /api/apps/:name`

Detailed status for a single app: config, containers, recent deploys.

```json
{
  "app": {
    "name": "my-app",
    "config": { "name": "my-app", "health": "/api/health", "..." : "..." },
    "commit": "abc1234",
    "containers": "...",
    "recentDeploys": []
  }
}
```

### `POST /api/apps/:name/deploy`

Trigger a deploy. Runs pre-flight checks, then git pull + compose build + compose up + health check.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stream` (query) | `boolean` | `false` | When `true`, returns an SSE (Server-Sent Events) stream of deploy steps instead of a single JSON response |
| `branch` (body) | `string` | current branch | Git branch to pull. When omitted, the relay pulls the app's currently checked-out branch (`git rev-parse --abbrev-ref HEAD`), falling back to `main` only if that yields nothing |
| `force` (body) | `boolean` | `false` | Skip non-critical preflight checks |

Response: deploy result with step-by-step output, commit before/after, and duration. With `stream=true`, response is `text/event-stream` with one event per step. A step killed by `step_timeout_seconds` or the 64 MB stdout/stderr buffer cap has a `[relay] ...` line appended to its output naming the reason, instead of leaving a bare non-zero exit and truncated output to interpret.

### `POST /api/apps/:name/rollback`

Rollback an app to a previous commit, rebuild, and restart. Runs `git reset --hard`, then two critical preflight checks (`apps_root_mount_congruence`, `compose_bind_mount_sources_exist` — the same DooD bind-mount-safety gate a deploy runs), then `docker compose build` + `up`.

| Body field | Type | Default | Description |
|-------|------|---------|-------------|
| `to_commit` | `string` | `HEAD~1` | Target commit SHA (hex, 4-40 chars) or `HEAD~N` |

Response is one of two `200` shapes:

- Success: `{ "deploy": { "...": "..." }, "success": true, "commitBefore": "abc1234", "commitAfter": "def5678" }` — `deploy` is the recorded history entry (same shape as `GET /api/deploys` entries).
- Blocked (a critical preflight check rejected the rollback): `{ "result": { "success": false, "blocked": true, "preflight": { "passed": false, "checks": [ "..." ] }, "commitBefore": "abc1234", "commitAfter": "def5678" } }`. The working tree has already been reset to the target commit at this point (`commitAfter` reflects that), but `compose build`/`up` never ran, so the running containers are unchanged. No `deploy` history entry is recorded for a blocked rollback, same as a blocked deploy.

A rollback failure that isn't a blocked preflight (bad commit ref, `compose build`/`up` failure, …) still returns `400 { "error": "..." }`, not either shape above.

### `GET /api/apps/:name/logs`

Recent Docker Compose logs.

| Query param | Type | Default | Description |
|-------|------|---------|-------------|
| `lines` | `number` | `50` | Number of log lines (max 1000) |
| `service` | `string` | -- | Filter to a specific service name |

```json
{ "app": "my-app", "lines": 50, "logs": "..." }
```

### `GET /api/apps/:name/preflight`

Run pre-flight checks without deploying.

```json
{
  "app": "my-app",
  "passed": true,
  "checks": [
    { "name": "compose_file_exists", "passed": true, "message": "docker-compose.yml found", "critical": true },
    { "name": "containers_running", "passed": true, "message": "Containers are running", "critical": false },
    { "name": "traefik_labels", "passed": true, "message": "Traefik labels found", "critical": false },
    { "name": "health_defined", "passed": true, "message": "Health endpoint: /api/health", "critical": true },
    { "name": "git_clean", "passed": true, "message": "Working tree clean", "critical": false },
    { "name": "git_remote_reachable", "passed": true, "message": "Git remote is reachable", "critical": false },
    { "name": "apps_root_mount_congruence", "passed": true, "message": "Host and relay agree on /apps (mount congruence probe round-tripped)", "critical": true },
    { "name": "compose_bind_mount_sources_exist", "passed": true, "message": "All 2 compose bind-mount source(s) exist.", "critical": true }
  ]
}
```

### `GET /api/deploys`

List deploy history across all apps or filtered by app.

| Query param | Type | Description |
|-------|------|-------------|
| `app` | `string` | Filter by app name (optional) |

```json
{
  "deploys": [
    {
      "id": "d-1",
      "app": "my-app",
      "status": "success",
      "commitBefore": "abc1234",
      "commitAfter": "def5678",
      "durationMs": 12345,
      "triggeredBy": "api",
      "createdAt": "2026-01-01T00:00:00.000Z"
    }
  ]
}
```

### `GET /api/apps/:name/env`

Read an app's `.env` as a flat list of key/value entries. Returns an empty list if the app has no `.env`. Values are returned **raw and unmasked**: the relay is already behind the bearer token, and any caller with that token has full VPS access, so masking is left to the consuming UI (the consent boundary is the panel, not the relay).

```json
{ "entries": [ { "key": "AUTH_TOKEN", "value": "s3cr3t" } ] }
```

### `PUT /api/apps/:name/env`

Replace an app's `.env` with the supplied entries (full overwrite, written atomically at mode `0600`). The body must be `{ "entries": [ { "key", "value" } ] }`; both `key` and `value` must be strings. Validation limits: at most 500 entries, key length 1..128, value length up to 32768 characters, and duplicate keys are rejected (`400` on any violation). Returns the written entries.

Comments in the existing `.env` are **not** preserved across a read/write round-trip; keep canonical comments in `.env.example` instead.

```json
{ "entries": [ { "key": "AUTH_TOKEN", "value": "s3cr3t" } ] }
```

## MCP tools

The MCP server exposes 5 tools at `/mcp`. Same `AUTH_TOKEN` as the HTTP API.

### `relay_deploy`

Deploy an app: git pull, compose build, compose up, health check. Auto-rollback on failure.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name under `APPS_DIR` |
| `branch` | `string` | No | Git branch to pull. Defaults to the app's currently checked-out branch (falls back to `main`) |
| `force` | `boolean` | No | Skip non-critical preflight checks |

### `relay_status`

Get status of an app or all apps: container state, health, current commit.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | No | App name (lists all apps if omitted) |

### `relay_rollback`

Rollback an app to a previous commit, rebuild, and restart.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |
| `to_commit` | `string` | No | Target commit SHA or `HEAD~N` (default: `HEAD~1`) |

### `relay_logs`

Recent Docker Compose logs.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |
| `lines` | `number` | No | Number of log lines (default: 50, max: 1000) |
| `service` | `string` | No | Specific service name |

### `relay_preflight`

Run pre-flight checks without deploying. Returns the same 8 checks as `GET /api/apps/:name/preflight`.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |
