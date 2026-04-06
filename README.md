# agent-relay

> **Status: Work in Progress**

VPS deployment relay for AI agents. Runs as a daemon on your server and exposes deployment capabilities via MCP (Model Context Protocol) and HTTP API.

## What it does

agent-relay turns your VPS into a deployment target that AI agents (like Claude Code) can control directly:

```
[Claude Code] --MCP--> [agent-relay on VPS] --Docker Compose--> [Your Apps]
```

- **Update running apps** — `git pull`, `docker compose build`, `docker compose up -d`
- **Health checks** — verify apps are healthy after deploy, auto-rollback on failure
- **Pre-flight checks** — validate config, containers, Traefik labels before touching anything
- **Rollback** — revert to previous commit if something breaks
- **Logs** — stream Docker Compose logs to the agent

## Architecture

```
VPS
├── Traefik (reverse proxy, TLS)
├── agent-relay (this project)
│   ├── MCP Server (for AI agents)
│   ├── HTTP API (for deploy-panel)
│   ├── Deploy Engine
│   └── Pre-flight Checks
└── Your Apps (Docker Compose)
```

## App Configuration

Each app has a `.relay.yml` in its root directory:

```yaml
name: my-app
health: /api/health
compose_file: docker-compose.prod.yml
post_update:
  - docker compose exec backend npx prisma migrate deploy
rollback: true
```

## Scope

agent-relay is an **update runner**, not a provisioning tool. It updates apps that are already deployed and running. Initial setup (Docker, Traefik, first deploy) is handled separately.

## Tech Stack

- Node.js 22 + TypeScript
- MCP SDK (Model Context Protocol)
- Hono (HTTP API)
- Dockerode (Docker API client)

## Roadmap

- [x] Project scaffold
- [ ] `.relay.yml` config parser
- [ ] Pre-flight checks
- [ ] Deploy engine (git pull + compose + health check + rollback)
- [ ] MCP Server (deploy, status, rollback, logs tools)
- [ ] HTTP API (for deploy-panel)
- [ ] VPS installer script

## Related

- [deploy-panel](https://github.com/LanNguyenSi/deploy-panel) — Web UI for managing servers and deployments

## License

MIT
