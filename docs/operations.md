# Operations

Installing the relay on a VPS, running it locally for development, and the runtime env vars it cares about.

## VPS installer

One-command install on Ubuntu/Debian:

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

The installer pulls the published Docker image from `ghcr.io/lannguyensi/agent-relay:latest`, built and pushed by `.github/workflows/publish.yml` on every merge to `main` and every `v*` tag. The image must be **public** for the unauthenticated pull to work; after the first workflow run on a fresh repository, a maintainer must flip the package visibility once at [github.com/users/LanNguyenSi/packages/container/agent-relay/settings](https://github.com/users/LanNguyenSi/packages/container/agent-relay/settings) (GitHub defaults new packages to Private). If you see `denied` from the pull step, that is almost always the cause.

The installer:

1. Installs Docker and Docker Compose (if missing).
2. Detects what's on port 80 and picks an install mode (see below).
3. In `greenfield` mode: creates `traefik-public` network + starts Traefik.
4. Pulls and starts the agent-relay container (with mode-appropriate network and labels).
5. Generates an auth token (if not already set).
6. Prints connection info (including the resolved mode).

## Install modes

`RELAY_MODE` (default `auto`) selects how the relay exposes itself:

| Mode | What it does | When to use |
|------|--------------|-------------|
| `greenfield` | Creates `traefik-public` network + a Traefik container with Let's Encrypt; relays routes to `RELAY_DOMAIN` | Fresh VPS, nothing on :80/:443 |
| `existing-traefik` | Skips Traefik creation; joins the relay to `TRAEFIK_NETWORK` with labels routing `RELAY_DOMAIN` via `TRAEFIK_CERTRESOLVER` | VPS already has a Traefik you want to route through |
| `port-only` | No Traefik, no TLS; relay binds `RELAY_BIND:RELAY_PORT` directly on the host | Non-Traefik reverse proxy (nginx/Caddy) handles TLS, or you only need loopback access |
| `auto` (default) | Detects :80. Free → `greenfield`. Owned by a Traefik container → `existing-traefik`. Owned by anything else + `RELAY_DOMAIN` unset → `port-only`. Owned by anything else + `RELAY_DOMAIN` set → **refuse** with actionable guidance | Let the installer pick |

## Installer environment variables

Set these before running the script to customise the install:

| Variable | Default | Description |
|----------|---------|-------------|
| `RELAY_MODE` | `auto` | `auto` / `greenfield` / `existing-traefik` / `port-only` |
| `RELAY_DOMAIN` | -- | FQDN the relay should serve. Required for `greenfield` (TLS) and `existing-traefik` |
| `TRAEFIK_EMAIL` | -- | Email for Let's Encrypt. Required in `greenfield` when `RELAY_DOMAIN` is set |
| `TRAEFIK_NETWORK` | `traefik-public` | Docker network of the existing Traefik (used in `existing-traefik` mode) |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | ACME resolver name configured on the existing Traefik |
| `RELAY_BIND` | `127.0.0.1` | Host bind IP for `port-only` mode. Use `0.0.0.0` to expose publicly |
| `APPS_DIR` | `/home/deploy/apps` (root) or `$HOME/.local/share/agent-relay/apps` (non-root) | Host directory containing app directories |
| `RELAY_DIR` | `/opt/agent-relay` (root) or `$HOME/.local/share/agent-relay` (non-root) | Directory for relay config and compose file |
| `RELAY_PORT` | `8222` | Port for the relay HTTP server |
| `SKIP_TRAEFIK` | -- | `1` = back-compat alias for `RELAY_MODE=port-only` (only applied when `RELAY_MODE` is left at `auto`) |

### Examples

Greenfield (fresh VPS):

```bash
RELAY_DOMAIN=relay.example.com \
TRAEFIK_EMAIL=you@example.com \
APPS_DIR=/home/deploy/apps \
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

Existing Traefik on a different network:

```bash
RELAY_MODE=existing-traefik \
RELAY_DOMAIN=relay.example.com \
TRAEFIK_NETWORK=proxy \
TRAEFIK_CERTRESOLVER=myresolver \
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

Port-only (nginx handles TLS, relay on loopback):

```bash
RELAY_MODE=port-only \
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

### Non-root install

The installer can run without `sudo` if your user is in the `docker` group. It detects this automatically via `docker info` and enters non-root mode.

Requirements:

- **docker group**: `sudo usermod -aG docker $USER` then log out/in so `docker info` succeeds without `sudo`.
- **HOME-writable paths**: all files go to HOME-relative directories. Defaults and overrides:
  - `RELAY_DIR` defaults to `$HOME/.local/share/agent-relay` (override with `RELAY_DIR=...`). `/opt/agent-relay` is never created in non-root mode.
  - `APPS_DIR` defaults to `$HOME/.local/share/agent-relay/apps` (override with `APPS_DIR=...`). `/home/deploy/apps` is never created in non-root mode.
- **Existing reverse proxy**: `RELAY_MODE=greenfield` is rejected in non-root mode with a clear error because Traefik bootstrap writes to `/opt/traefik` and binds :80/:443. Use `existing-traefik` (join an existing Traefik) or `port-only` instead.

Example (join an existing Traefik):

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh \
  | RELAY_MODE=existing-traefik RELAY_DOMAIN=relay.example.com bash
```

Example (port-only, no TLS):

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh \
  | RELAY_MODE=port-only RELAY_BIND=0.0.0.0 bash
```

(Env vars go to the right of the pipe so they reach the `bash` running the script.)

## Running locally

### Development

```bash
git clone https://github.com/LanNguyenSi/agent-relay.git
cd agent-relay
npm install
cp .env.example .env   # set AUTH_TOKEN
npm run dev            # starts on port 8222 with hot reload (tsx watch)
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

## Runtime environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | -- | Bearer token for API and MCP authentication |
| `PORT` | No | `8222` | HTTP server port |
| `APPS_DIR` | No | `/home/deploy/apps` | Directory containing app directories |
