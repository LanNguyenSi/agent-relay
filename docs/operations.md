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
| `TRAEFIK_EMAIL` | -- | Email for Let's Encrypt. Required in `greenfield` when `RELAY_DOMAIN` is set. Not required when `TRAEFIK_CA=self-signed`. |
| `TRAEFIK_NETWORK` | `traefik-public` | Docker network of the existing Traefik (used in `existing-traefik` mode) |
| `TRAEFIK_CERTRESOLVER` | `letsencrypt` | ACME resolver name configured on the existing Traefik |
| `TRAEFIK_CA` | `letsencrypt` | TLS provider for greenfield Traefik. Values: `letsencrypt` (default, production LE), `staging` (LE staging CA, untrusted cert), `pebble` (custom Pebble CA at `PEBBLE_URL`), `self-signed` (Traefik built-in cert, no ACME). Only affects `greenfield` mode. |
| `PEBBLE_URL` | -- | Pebble CA server URL (e.g. `https://pebble:14000/dir`). Required when `TRAEFIK_CA=pebble` |
| `RELAY_BIND` | `127.0.0.1` | Host bind IP for `port-only` mode. Use `0.0.0.0` to expose publicly |
| `APPS_DIR` | `/home/deploy/apps` (root) or `$HOME/.local/share/agent-relay/apps` (non-root) | Host directory containing app directories |
| `RELAY_DIR` | `/opt/agent-relay` (root) or `$HOME/.local/share/agent-relay` (non-root) | Directory for relay config and compose file |
| `RELAY_PORT` | `8222` | Port for the relay HTTP server |
| `SKIP_TRAEFIK` | -- | `1` = back-compat alias for `RELAY_MODE=port-only` (only applied when `RELAY_MODE` is left at `auto`) |

### APPS_DIR host/container contract

The relay container mounts the host's `APPS_DIR` at `/apps`, and the relay itself runs `docker compose` *inside* that container (Docker-outside-of-Docker, DooD) via the mounted `/var/run/docker.sock`. The docker **daemon** always resolves compose bind-mount sources against the **host** filesystem — it has no notion of the relay container's own view of `/apps`. The relay's `.env` always pins `APPS_DIR=/apps` (its in-container view), independent of whatever host directory the installer's `APPS_DIR` pointed at. So when the relay asks the daemon to bring up a deployed app whose compose file bind-mounts a path under `/apps`, the daemon must find that same content at the literal host path `/apps`.

The contract this implies: the host directory `/apps` must be **the same directory** as the true apps dir. In practice that means either:

- `APPS_DIR` on the host **is** `/apps`, or
- `/apps` on the host is a **symlink** to the real `APPS_DIR` (for example `/apps -> /root/git`).

`install.sh` enforces this automatically on every run: if `APPS_DIR != /apps`, it creates the symlink when `/apps` does not exist yet, confirms an existing symlink already resolves to the right target, or fails loudly with the exact fix command if `/apps` exists as anything else (a real directory, a plain file, or a symlink to somewhere else). It never silently overwrites an existing `/apps`.

Two preflight checks in `src/deploy/preflight.ts` guard this contract on every deploy:

- **`apps_root_mount_congruence`** (pre-pull, critical) — round-trips a marker token through a throwaway `docker run` that bind-mounts `APPS_DIR`. If the relay is containerized and the daemon cannot see the marker (or sees something else), the host and the relay disagree about `/apps`, and the check fails closed with a fix hint pointing at the host symlink. It passes trivially when the relay is not containerized at all (no DooD, so no daemon-vs-container view gap is possible).
- **`compose_bind_mount_sources_exist`** (post-pull, critical) — parses the freshly pulled app's compose file and checks that every bind-mount source path under `APPS_DIR` actually exists from the relay's own filesystem view. Named volumes and unresolved `${VAR}` or outside-`APPS_DIR` absolute paths are skipped, not checked.

**Why this matters (2026-07-15 incident):** when the host and the relay disagreed about `/apps`, `docker compose` did not error — it silently auto-created every missing file bind-mount source as an **empty directory** on the host, while the deploy still reported success. A deployed app's real config file was shadowed by an empty directory of the same name. If either preflight check above fails, start by running `docker inspect <relay-container>` on the docker host to find the real apps directory, then create the symlink by hand: `sudo ln -s <real apps dir> /apps`.

### Examples

> **Note:** shell env-var prefixes bind to the command they precede. In `VAR=x curl ... | sudo bash`, `VAR` is set for `curl`, not for the `bash` that runs the downloaded script -- and `sudo` resets the environment by default. Download the script first, then pass env vars on the `sudo` line. If your sudoers strips command-line variables, export them and use `sudo -E`, or run as root directly.

Greenfield (fresh VPS):

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh -o /tmp/agent-relay-install.sh
sudo RELAY_DOMAIN=relay.example.com \
     TRAEFIK_EMAIL=you@example.com \
     APPS_DIR=/home/deploy/apps \
     bash /tmp/agent-relay-install.sh
```

Existing Traefik on a different network:

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh -o /tmp/agent-relay-install.sh
sudo RELAY_MODE=existing-traefik \
     RELAY_DOMAIN=relay.example.com \
     TRAEFIK_NETWORK=proxy \
     TRAEFIK_CERTRESOLVER=myresolver \
     bash /tmp/agent-relay-install.sh
```

Port-only (nginx handles TLS, relay on loopback):

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh -o /tmp/agent-relay-install.sh
sudo RELAY_MODE=port-only bash /tmp/agent-relay-install.sh
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

The `docker-compose.yml` mounts `/var/run/docker.sock` (for container management), the apps directory, and `/root/.ssh` read-only (so `git pull` can authenticate to private remotes over SSH). Override the SSH source path with `SSH_DIR` in the dev `docker-compose.yml`; the production `docker-compose.prod.example.yml` mounts it the same way. If your apps only use public or HTTPS git remotes, the SSH mount is harmless but unused.

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
| `APPS_DIR` | No | `/apps` | Directory containing app directories, as seen by the relay process. The installer bind-mounts the host's `/home/deploy/apps` (root) onto `/apps` inside the container, so this rarely needs overriding |
