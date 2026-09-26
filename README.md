# agent-relay

AI-driven VPS deployment relay: an MCP server and HTTP API that lets Claude Code (or any MCP client) and [deploy-panel](https://github.com/LanNguyenSi/deploy-panel) deploy, rollback, and monitor Docker Compose apps, without ever opening an SSH session.

```
                         AUTH_TOKEN gate
                               |
                               v
[Claude Code]   --MCP-->  +------------+   --git pull--> [Your Apps]
                          |            |   --compose -->  (Docker
[deploy-panel]  --HTTP--> | agent-relay |  --health  -->   Compose
                          |            |   --rollback->   under
[uptime probe]  --GET --> +------------+                  APPS_DIR)
                /health (no auth)
```

## Overview

`ssh root@vps && docker compose up -d` has no place for an AI agent: `ssh` needs a private key and a TTY, and it validates nothing before or after the deploy. agent-relay replaces it with a single daemon, one auth token, and one HTTP/MCP surface: pre-flight checks before and after `git pull`, an automatic rollback on a failed health check, and a deploy history. It runs on the VPS itself, alongside the apps it deploys.

## Key features

- Pre-flight checks before `git pull` (working tree clean, remote reachable) and after (compose file exists, containers running, Traefik labels present, health endpoint defined).
- Automatic rollback to the previous commit when the post-deploy health check fails; see [Deploy lifecycle](docs/operations.md#deploy-lifecycle) for the full flow and diagram.
- Deploy history: the last 100 deploys (across all apps), with commit before/after, status, duration, and trigger source.
- One bearer token secures both the HTTP API and the 5 MCP tools.
- Centralized management of multiple VPS targets from [deploy-panel](https://github.com/LanNguyenSi/deploy-panel).

## Quick start

On a fresh Ubuntu/Debian VPS (root, or a user in the `docker` group; the installer installs Docker/Compose if either is missing):

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh -o /tmp/agent-relay-install.sh
sudo RELAY_DOMAIN=relay.example.com \
     TRAEFIK_EMAIL=you@example.com \
     bash /tmp/agent-relay-install.sh
```

> Env vars must be set on the `sudo` line, not before `curl`: the pipe binds them to the download, not to the `bash` that runs the script. If your sudoers strips command-line variables, `export` them and use `sudo -E`, or run as root directly.

Without a domain, drop `RELAY_DOMAIN` for a loopback, no-TLS `port-only` install:

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

The installer prints a generated `AUTH_TOKEN` on success. It also supports a non-root install for users in the `docker` group; see [docs/operations.md](docs/operations.md#non-root-install) for the requirements, and [docs/operations.md](docs/operations.md#apps_dir-hostcontainer-contract) for the `APPS_DIR` host/container contract the installer enforces (the docker daemon runs `docker compose` for deployed apps against the host's own `/apps`, so it must be the same directory as `APPS_DIR`).

## Usage

Every write goes through the same bearer token, over HTTP or MCP:

```bash
curl -X POST -H "Authorization: Bearer $AUTH_TOKEN" \
  https://relay.example.com/api/apps/my-app/deploy
```

That call runs `git pull`, pre-flight checks, `docker compose build`/`up`, and the health check for the app named `my-app`. The MCP tool `relay_deploy` does the same thing over `/mcp`. The full HTTP API, the 5 MCP tools, and the `.relay.yml` each app needs to ship are in [docs/integration.md](docs/integration.md).

## Documentation

- [docs/operations.md](docs/operations.md): installing on a VPS, install modes, running locally, the deploy lifecycle, runtime env vars.
- [docs/integration.md](docs/integration.md): `.relay.yml` config reference, the HTTP API, the 5 MCP tools.
- [docs/security.md](docs/security.md): the auth model, the shell-exec trust boundary, public vs authenticated endpoints.
- [CONTRIBUTING.md](CONTRIBUTING.md): issue and PR process, dev setup, style.
- [deploy-panel](https://github.com/LanNguyenSi/deploy-panel): web UI for managing servers and deployments.

## Development and contributing

```bash
npm install
npm run build
npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the PR process, issue guidelines, and dogfooding a deployment-path change against a real VPS or `docker-compose.prod.example.yml`.

## License

[MIT](LICENSE)
