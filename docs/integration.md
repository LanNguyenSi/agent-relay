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
```

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | Yes | -- | App identifier |
| `health` | `string` | Yes | -- | Health check endpoint path (e.g. `/api/health`) |
| `compose_file` | `string` | No | `docker-compose.yml` | Docker Compose file name. Must match `[A-Za-z0-9._/-]+` and not contain `..` segments; value is interpolated into shell. |
| `command` | `string` | No | -- | Custom deploy command (replaces default git+compose flow). **Arbitrary shell.** |
| `pre_update` | `string[]` | No | `[]` | Commands to run before the deploy. **Arbitrary shell.** |
| `post_update` | `string[]` | No | `[]` | Commands to run after compose up. **Arbitrary shell.** |
| `health_port` | `number` | No | -- | Port for health check requests (if different from Traefik-routed port) |
| `rollback` | `boolean` | No | `true` | Auto-rollback to previous commit on failure |

The shell-exec fields (`command`, `pre_update`, `post_update`) cross a real trust boundary: see [docs/security.md](security.md).

## HTTP API

All `/api` endpoints require `Authorization: Bearer <AUTH_TOKEN>` unless noted otherwise. Base path: `/api`.

### `GET /health`

Public relay health check. **No authentication required.** Returns status and version but does not include uptime. Useful for external uptime monitors and load balancer probes.

```json
{ "status": "ok", "version": "0.1.0" }
```

### `GET /api/health`

Authenticated relay health check. Same as `/health` but includes server uptime.

```json
{ "status": "ok", "version": "0.1.0", "uptime": 12345.67 }
```

### `GET /api/system`

Server resource metrics (CPU, memory, disk).

```json
{
  "cpu": { "cores": 4, "usage": 23.5 },
  "memory": { "totalMb": 8192, "usedMb": 4096, "usage": 50.0 },
  "disk": { "totalGb": 100, "usedGb": 42, "usage": 42.0 }
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
| `branch` (body) | `string` | `main` | Git branch to pull |
| `force` (body) | `boolean` | `false` | Skip non-critical preflight checks |

Response: deploy result with step-by-step output, commit before/after, and duration. With `stream=true`, response is `text/event-stream` with one event per step.

### `POST /api/apps/:name/rollback`

Rollback an app to a previous commit, rebuild, and restart.

| Body field | Type | Default | Description |
|-------|------|---------|-------------|
| `to_commit` | `string` | `HEAD~1` | Target commit SHA (hex, 4-40 chars) or `HEAD~N` |

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
    { "name": "git_remote_reachable", "passed": true, "message": "Git remote is reachable", "critical": true }
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

## MCP tools

The MCP server exposes 5 tools at `/mcp`. Same `AUTH_TOKEN` as the HTTP API.

### `relay_deploy`

Deploy an app: git pull, compose build, compose up, health check. Auto-rollback on failure.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name under `APPS_DIR` |
| `branch` | `string` | No | Git branch to pull (default: main) |
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

Run pre-flight checks without deploying. Returns the same six checks as `GET /api/apps/:name/preflight`.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |
