# agent-relay

VPS deployment relay for AI agents. Runs as a daemon on your server and exposes deployment capabilities via MCP (Model Context Protocol) and HTTP API. AI agents like Claude Code can deploy, rollback, and monitor your Docker Compose apps directly.

## How it works

```
[Claude Code] --MCP--> [agent-relay on VPS] --Docker Compose--> [Your Apps]
[deploy-panel] --HTTP API--> [agent-relay on VPS] --Docker Compose--> [Your Apps]
```

Each app on your VPS is a git repo with a `docker-compose.yml` and a `.relay.yml` config file. agent-relay manages the deploy lifecycle:

1. **Pre-flight checks** -- validate config, containers, Traefik labels, git status
2. **Deploy** -- `pre_update` commands, `git pull`, **re-read `.relay.yml`**, `docker compose build`, `docker compose up -d`, `post_update` commands
3. **Health check** -- HTTP health endpoint with exponential backoff retries
4. **Auto-rollback** -- revert to previous commit on health check failure

`.relay.yml` is re-read after `git pull` so config edits shipped in the same commit as the code they support take effect on that same deploy — `compose_file`, `post_update`, `health`, and `health_port` all use the post-pull values. Pre-flight checks and `pre_update` commands intentionally run against the pre-pull config (they answer "is it safe to pull?", not "will the new config work?"). Rollback also keeps the pre-pull config, because `git reset --hard` restores the old tree where the old `compose_file` is on disk.

## Architecture

```
VPS
+-- Traefik (reverse proxy, TLS)
+-- agent-relay (this project)
|   +-- MCP Server        (/mcp -- for AI agents)
|   +-- HTTP API           (/api -- for deploy-panel)
|   +-- Deploy Engine      (git pull + compose + health + rollback)
|   +-- Pre-flight Checks  (6 checks before deploy)
|   +-- Deploy History     (JSON file, last 100 deploys)
+-- Your Apps (Docker Compose projects under APPS_DIR)
```

### Modules

| Module | Path | Purpose |
|--------|------|---------|
| Config | `src/config/relay.ts` | `.relay.yml` schema and parser (Zod) |
| Env | `src/config/env.ts` | Environment variable validation |
| Deploy Engine | `src/deploy/engine.ts` | Full deploy flow with step tracking |
| Pre-flight | `src/deploy/preflight.ts` | 6 pre-deploy validation checks |
| Health | `src/deploy/health.ts` | HTTP health check with retries |
| MCP Server | `src/mcp/server.ts` | 5 MCP tools for AI agents |
| HTTP API | `src/api/routes.ts` | REST API for deploy-panel |
| App Services | `src/services/apps.ts` | Shared business logic |
| History | `src/services/history.ts` | Deploy history storage |

## `.relay.yml` config reference

Place a `.relay.yml` in each app's root directory:

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
| `compose_file` | `string` | No | `docker-compose.yml` | Docker Compose file name |
| `command` | `string` | No | -- | Custom deploy command (replaces default git+compose flow) |
| `pre_update` | `string[]` | No | `[]` | Commands to run before the deploy |
| `post_update` | `string[]` | No | `[]` | Commands to run after compose up |
| `health_port` | `number` | No | -- | Port for health check requests (if different from Traefik-routed port) |
| `rollback` | `boolean` | No | `true` | Auto-rollback to previous commit on failure |

## HTTP API reference

All `/api` endpoints require `Authorization: Bearer <AUTH_TOKEN>` header unless noted otherwise.

Base path: `/api`

### `GET /health`

Public relay health check. **No authentication required.** Returns status and version but does not include uptime. Useful for external uptime monitors and load balancer probes.

**Response:**
```json
{ "status": "ok", "version": "0.1.0" }
```

### `GET /api/health`

Authenticated relay health check. Same as `/health` but includes server uptime. Requires `Authorization` header.

**Response:**
```json
{ "status": "ok", "version": "0.1.0", "uptime": 12345.67 }
```

### `GET /api/system`

Returns server resource metrics (CPU, memory, disk usage).

**Response:**
```json
{
  "cpu": { "cores": 4, "usage": 23.5 },
  "memory": { "totalMb": 8192, "usedMb": 4096, "usage": 50.0 },
  "disk": { "totalGb": 100, "usedGb": 42, "usage": 42.0 }
}
```

### `GET /api/apps`

List all apps in APPS_DIR with config status and current commit.

**Response:**
```json
{
  "apps": [
    { "name": "my-app", "configured": true, "health": "/api/health", "commit": "abc1234" },
    { "name": "other-app", "configured": false }
  ]
}
```

### `GET /api/apps/:name`

Get detailed status for a single app including config, containers, and recent deploys.

**Response:**
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

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `stream` | `boolean` | `false` | When `true`, returns an SSE (Server-Sent Events) stream of deploy steps instead of a single JSON response. Each event has a `step` and `status` field. |

**Request body (optional):**
```json
{ "branch": "main", "force": false }
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `branch` | `string` | `main` | Git branch to pull |
| `force` | `boolean` | `false` | Skip non-critical preflight checks |

**Response:** Deploy result with step-by-step output, commit before/after, and duration. When `stream=true`, the response is `text/event-stream` with one event per deploy step.

### `POST /api/apps/:name/rollback`

Rollback an app to a previous commit, rebuild, and restart.

**Request body (optional):**
```json
{ "to_commit": "abc1234" }
```

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `to_commit` | `string` | `HEAD~1` | Target commit SHA (hex, 4-40 chars) or `HEAD~N` |

### `GET /api/apps/:name/logs`

Fetch recent Docker Compose logs.

**Query params:**

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `lines` | `number` | `50` | Number of log lines (max 1000) |
| `service` | `string` | -- | Filter to a specific service name |

**Response:**
```json
{ "app": "my-app", "lines": 50, "logs": "..." }
```

### `GET /api/apps/:name/preflight`

Run pre-flight checks without deploying.

**Response:**
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

**Query params:**

| Param | Type | Description |
|-------|------|-------------|
| `app` | `string` | Filter by app name (optional) |

**Response:**
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

## MCP tools reference

The MCP server exposes 5 tools for AI agents. Connect via the `/mcp` endpoint.

### `relay_deploy`

Deploy an app: git pull, compose build, compose up, health check. Auto-rollback on failure.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name under APPS_DIR |
| `branch` | `string` | No | Git branch to pull (default: main) |
| `force` | `boolean` | No | Skip non-critical preflight checks |

**Output:** Deploy result with success status, commit before/after, step-by-step results, and total duration.

### `relay_status`

Get status of an app or all apps: container state, health, current commit.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | No | App name (lists all apps if omitted) |

**Output:** App detail (config, commit, containers) or list of all apps with config status.

### `relay_rollback`

Rollback an app to a previous commit, rebuild, and restart.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |
| `to_commit` | `string` | No | Target commit SHA or `HEAD~N` (default: `HEAD~1`) |

**Output:** Rollback result with commit before/after.

### `relay_logs`

Get recent Docker Compose logs for an app.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |
| `lines` | `number` | No | Number of log lines (default: 50, max: 1000) |
| `service` | `string` | No | Specific service name |

**Output:** Log text from `docker compose logs`.

### `relay_preflight`

Run pre-flight checks on an app without deploying.

| Input | Type | Required | Description |
|-------|------|----------|-------------|
| `app` | `string` | Yes | App directory name |

**Output:** Pre-flight report with 6 checks (compose_file_exists, containers_running, traefik_labels, health_defined, git_clean, git_remote_reachable) each marked as passed/failed and critical/non-critical.

## VPS installer

One-command install on Ubuntu/Debian:

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

The installer:
1. Installs Docker and Docker Compose (if missing)
2. Creates `traefik-public` network and starts Traefik (if not running)
3. Pulls and starts the agent-relay container
4. Generates an auth token (if not already set)
5. Prints connection info

### Installer environment variables

Set these before running the script to customize the install:

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_DOMAIN` | -- | Domain for Traefik TLS (e.g. `relay.example.com`). Omit for port-only mode. |
| `TRAEFIK_EMAIL` | -- | Email for Let's Encrypt. Required if `RELAY_DOMAIN` is set. |
| `APPS_DIR` | `/home/deploy/apps` | Host directory containing app directories |
| `RELAY_DIR` | `/opt/agent-relay` | Directory for relay config and compose file |
| `RELAY_PORT` | `8222` | Port for the relay HTTP server |

Example with all options:

```bash
RELAY_DOMAIN=relay.example.com \
TRAEFIK_EMAIL=you@example.com \
APPS_DIR=/home/deploy/apps \
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

## Running locally

### Development

```bash
git clone https://github.com/LanNguyenSi/agent-relay.git
cd agent-relay
npm install
cp .env.example .env   # set AUTH_TOKEN
npm run dev             # starts on port 8222 with hot reload (tsx watch)
```

### Docker

```bash
# Set AUTH_TOKEN in environment or .env file
docker compose up --build
```

The `docker-compose.yml` mounts `/var/run/docker.sock` (for container management) and the apps directory.

### Scripts

| Script | Command | Description |
|--------|---------|-------------|
| `dev` | `tsx watch src/index.ts` | Dev server with hot reload |
| `build` | `tsc` | Compile TypeScript |
| `start` | `node dist/index.js` | Run production build |
| `lint` | `eslint src/` | Lint source code |
| `typecheck` | `tsc --noEmit` | Type check without emitting |
| `test` | `vitest run` | Run tests |
| `test:watch` | `vitest` | Run tests in watch mode |

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | -- | Bearer token for API and MCP authentication |
| `PORT` | No | `8222` | HTTP server port |
| `APPS_DIR` | No | `/home/deploy/apps` | Directory containing app directories |

## Tech stack

- Node.js 20+ / TypeScript
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (Model Context Protocol)
- [Hono](https://hono.dev) (HTTP API)
- [Dockerode](https://github.com/apocas/dockerode) (Docker API client)
- [Zod](https://zod.dev) (config and input validation)

## Related

- [deploy-panel](https://github.com/LanNguyenSi/deploy-panel) -- Web UI for managing servers and deployments

## License

[MIT](LICENSE)
