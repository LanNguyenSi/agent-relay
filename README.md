# agent-relay

The deploy daemon for AI-driven VPS deployments. Claude Code (or any MCP client) and [deploy-panel](https://github.com/LanNguyenSi/deploy-panel) can deploy, rollback, and monitor your Docker Compose apps without ever opening an SSH session.

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

## Why not just SSH + Docker

`ssh root@vps && docker compose up -d` works on day one. It stops working when:

- An AI agent needs to do it. `ssh` requires a private key and a TTY; an MCP-driven agent has neither.
- You want pre-flight checks before clobbering a working deploy. The relay validates `compose_file` exists, containers are running, Traefik labels are present, the health endpoint is defined, the working tree is clean, and the git remote is reachable, all before pulling.
- A health check fails after `compose up`. The relay auto-rolls back to the previous commit; bare SSH leaves you with a broken deploy.
- You want a deploy history. The relay keeps the last 100 deploys per app with commit before/after, status, duration, and trigger source.
- You're managing more than one VPS. Centralised state in deploy-panel, identical API on each box.

The relay is a daemon, not a CLI: one auth token, one HTTP/MCP surface, no SSH key sprawl.

## Try it in 60 seconds

On a fresh Ubuntu/Debian VPS:

```bash
RELAY_DOMAIN=relay.example.com \
TRAEFIK_EMAIL=you@example.com \
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

The installer detects what's on port 80, picks an install mode (greenfield with Traefik / join an existing Traefik / port-only behind nginx), pulls `ghcr.io/lannguyensi/agent-relay:latest`, and prints a generated `AUTH_TOKEN`. See [docs/operations.md](docs/operations.md) for the full mode matrix and env vars.

If you don't yet have a domain, drop `RELAY_DOMAIN` and the installer falls back to `port-only` mode (loopback bind, no TLS):

```bash
curl -sSL https://raw.githubusercontent.com/LanNguyenSi/agent-relay/main/install.sh | sudo bash
```

## Deploy lifecycle

Each app on the VPS is a git repo with a `docker-compose.yml` and a `.relay.yml`. The default flow:

1. **Deploy.** `pre_update` commands → `git pull` → re-read `.relay.yml` → pre-flight checks → `docker compose build` → `docker compose up -d` → `post_update` commands.
2. **Health check.** HTTP probe against the configured `health` path with exponential backoff retries.
3. **Auto-rollback.** On health failure, `git reset --hard` to the previous commit, rebuild, restart.

`.relay.yml` is re-read **after** `git pull` on purpose: a commit that *fixes* a broken `.relay.yml` lets the deploy through, instead of pre-flight gating on the stale pre-pull copy. Full rationale in [docs/security.md](docs/security.md#why-relayyml-is-re-read-after-git-pull).

## Next steps

| If you want to... | Read |
|------|------|
| Install the relay on a VPS, configure modes, run it locally | [docs/operations.md](docs/operations.md) |
| Wire up an app's `.relay.yml`, call the HTTP API, use the 5 MCP tools | [docs/integration.md](docs/integration.md) |
| Understand the auth model, the shell-exec trust boundary, and the public vs authenticated endpoints | [docs/security.md](docs/security.md) |

## Tech stack

- Node.js 20+ / TypeScript
- [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk) (Model Context Protocol)
- [Hono](https://hono.dev) (HTTP API)
- [Dockerode](https://github.com/apocas/dockerode) (Docker API client)
- [Zod](https://zod.dev) (config and input validation)

## Related

- [deploy-panel](https://github.com/LanNguyenSi/deploy-panel): Web UI for managing servers and deployments.

## License

[MIT](LICENSE)
