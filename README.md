# agent-relay

> **Status: Work in Progress** — This project is under active development. Features listed below are planned, not yet implemented unless marked with a checkmark.

VPS deployment relay for AI agents. Runs as a daemon on your server and exposes deployment capabilities via MCP (Model Context Protocol) and HTTP API.

## What it does

agent-relay turns your VPS into a deployment target that AI agents (like Claude Code) can control directly:

```
[Claude Code] --MCP--> [agent-relay on VPS] --Docker Compose--> [Your Apps]
```

**Planned capabilities:**

- **Update running apps** — `git pull`, `docker compose build`, `docker compose up -d`
- **Health checks** — verify apps are healthy after deploy, auto-rollback on failure
- **Pre-flight checks** — validate config, containers, Traefik labels before touching anything
- **Rollback** — revert to previous commit if something breaks
- **Logs** — stream Docker Compose logs to the agent

## Architecture (target)

```
VPS
├── Traefik (reverse proxy, TLS)
├── agent-relay (this project)
│   ├── MCP Server (for AI agents)      ← planned
│   ├── HTTP API (for deploy-panel)     ← planned
│   ├── Deploy Engine                   ← planned
│   └── Pre-flight Checks              ← planned
└── Your Apps (Docker Compose)
```

## App Configuration

Each app has a `.relay.yml` in its root directory:

```yaml
# Required
name: my-app
health: /api/health

# Optional overrides
# compose_file: docker-compose.prod.yml   # default: docker-compose.yml
# command: make deploy                     # overrides default git pull + compose flow

# Optional hooks
# pre_update:
#   - make db-generate
# post_update:
#   - docker compose exec backend npx prisma migrate deploy

# Auto-rollback on health check failure (default: true)
rollback: true
```

## Quick Start

```bash
git clone https://github.com/LanNguyenSi/agent-relay.git
cd agent-relay
npm install
cp .env.example .env   # set AUTH_TOKEN
npm run dev             # starts on port 8222
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUTH_TOKEN` | Yes | — | Bearer token for API/MCP authentication |
| `PORT` | No | `8222` | Server port |
| `APPS_DIR` | No | `/home/deploy/apps` | Directory containing app directories |

## Scope

agent-relay is an **update runner**, not a provisioning tool. It updates apps that are already deployed and running. Initial setup (Docker, Traefik, first deploy) is handled separately.

## Tech Stack

- Node.js 20+ / TypeScript
- MCP SDK (Model Context Protocol)
- Hono (HTTP API)
- Dockerode (Docker API client)
- Zod (config validation)

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

[MIT](LICENSE)
