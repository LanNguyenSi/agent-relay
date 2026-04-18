# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-04-18

**Headline: First tagged release of agent-relay — the VPS-side daemon
that turns a Docker-Compose host into a remotely-driveable deploy
target. Ships an MCP surface for AI agents (`Claude Code` and friends)
and an authenticated HTTP API for `deploy-panel`. Same daemon process
powers both protocols.**

This is the line in the sand: from v0.1.0 onward, `.relay.yml` schema,
config keys, env-var contract, MCP tool names, and HTTP routes follow
SemVer. Operators upgrading existing installs should re-pin and re-run
their deploy smoke test against the published image.

### Added

#### Deploy engine

- `src/deploy/engine.ts` — full deploy flow with step tracking:
  pre-flight → `git pull` → `docker compose build` → `docker compose
  up -d` → health check → optional auto-rollback to previous commit
  on health failure.
- Custom-command mode: `command:` in `.relay.yml` overrides the
  default git+compose flow when an app needs its own deploy script.
- `pre_update` / `post_update` hooks for migrations and similar
  side-effects bracketing the compose step.
- SSE streaming endpoint for live step events so deploy-panel can
  show real-time progress.

#### Pre-flight checks

- `src/deploy/preflight.ts` — six pre-deploy validation checks run
  before any container is touched: compose file exists, container
  state, Traefik labels, health endpoint defined, git working tree
  clean, and git remote reachable (non-critical).

#### Health check + rollback

- `src/deploy/health.ts` — HTTP health endpoint with exponential
  backoff retries.
- Health check via `docker compose exec` against the configured
  `health_port` so containers behind Traefik are reachable.
- Auto-rollback to the previous commit when health fails, controlled
  by `rollback:` in `.relay.yml` (default `true`).

#### MCP server

- `src/mcp/server.ts` — Model Context Protocol surface for AI
  agents. Five tools: `relay_deploy`, `relay_status`,
  `relay_rollback`, `relay_logs`, `relay_preflight`. Served over
  HTTP via `StreamableHTTPServerTransport` (no stdio transport in
  v0.1.0).

#### HTTP API

- `src/api/routes.ts` — REST API consumed by `deploy-panel`.
  Bearer-token auth via `AUTH_TOKEN`. Public `GET /health` for
  external uptime monitors; authenticated `GET /api/*` for everything
  else.
- `GET /api/system` — host CPU / RAM / disk metrics.
- `GET /api/apps/:name/env` (read) and `PUT /api/apps/:name/env`
  (write) — manage app `.env` via the relay (gated by auth).
- Deploy history persisted to a JSON file (last 100 entries) and
  exposed via the API.

#### Config

- `src/config/relay.ts` — Zod-validated `.relay.yml` schema:
  `name`, `health`, `compose_file`, `command`, `pre_update`,
  `post_update`, `health_port`, `rollback`.
- `src/config/env.ts` — env-var validation. Standardized
  `APPS_DIR` default to `/apps`.

#### Container + ops

- Multi-stage `Dockerfile` with `git`, `docker` CLI, and
  `openssh-client` in the runtime image so SSH-based git pulls work
  out of the box.
- `docker-compose.prod.example.yml` — canonical prod compose template
  with Traefik labels and the bind-mount layout the relay expects.
  Operators copy it to `docker-compose.prod.yml` and customize.
- `install.sh` — VPS bootstrap installer.
- Symlink-aware app discovery so apps mounted from non-standard
  locations are still picked up.

#### Repo + release engineering

- `.github/workflows/ci.yml` — typecheck, vitest, build, Docker
  build. Now reusable via `workflow_call` for the release workflow.
- `.github/workflows/release.yml` — tag-driven (`v*`) GitHub Release
  flow that calls CI as a reusable workflow and publishes the
  matching CHANGELOG section as the release body.
- `Makefile`, `README.md` with full API + MCP tool + config + installer
  reference, MIT license.
- `CHANGELOG.md`, this file.

### Changed

- `docker-compose.prod.yml` renamed to
  `docker-compose.prod.example.yml` to make it explicit that it is a
  template, not the runtime file. **Production installs must use a
  `docker-compose.prod.yml` (copied from the example) — the plain
  `docker-compose.yml` renames the container and drops Traefik
  labels + the apps bind-mount.**
- `safeAppDir` is now correctly awaited inside `deployAppStreaming`.
- Health check no longer hits `localhost`; iterates services + ports
  via `docker compose exec` instead.
- Health check skipped in test environment.
- Health check ports expanded; new optional `health_port` field for
  apps where the Traefik-routed port differs from the in-container
  port.
- Git branch is auto-detected instead of always defaulting to `main`.
- `git_remote_reachable` downgraded to non-critical so a transient
  remote outage does not block a redeploy from a cached worktree.

### Fixed

- `protobufjs` and `hono` bumped to patch one critical and one
  moderate CVE.
- `@hono/node-server` patch bump from `npm audit fix`.

### Migration notes

- **Compose file**: existing installs that copied
  `docker-compose.prod.yml` from the repo into place must rename
  their copy or re-run `install.sh`. Always run prod compose
  commands with `-f docker-compose.prod.yml`. Plain
  `docker compose` against the unprefixed file silently produces a
  different container name and loses Traefik routing.
- **`APPS_DIR`**: default is now `/apps`. Set the env var explicitly
  if your install used a different layout pre-v0.1.0.
- **Auth**: `AUTH_TOKEN` is required in env. There is no anonymous
  `/api/*` route.
