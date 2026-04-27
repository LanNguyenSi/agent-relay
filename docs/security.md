# Security

agent-relay runs as a long-lived daemon on a VPS, with access to the Docker socket and to every app under `APPS_DIR`. Two trust boundaries matter.

## API authentication

All `/api` endpoints require `Authorization: Bearer <AUTH_TOKEN>`. The exception is `GET /health`: a public, unauthenticated relay-health probe (status + version, no uptime), suitable for external uptime monitors and load balancer probes.

The auth model is intentionally minimal: one bearer token, constant-time compared. No rate limits, no TLS termination, no mTLS. TLS is the responsibility of whatever sits in front of the relay (Traefik in `greenfield` / `existing-traefik` modes; nginx or Caddy in `port-only`). See [docs/operations.md](operations.md) for install modes.

## `.relay.yml` shell-exec trust boundary

The `command`, `pre_update`, and `post_update` fields in `.relay.yml` execute as **arbitrary shell** on the deploy host, as the relay user, with access to the Docker socket. The implicit trust boundary is therefore **push access to the deployed branch**: anyone who can land a commit that edits `.relay.yml` can run anything the relay user can run.

Treat the deploy branch like a deploy key:

- Restrict who can push to it.
- Require code review for `.relay.yml` changes.
- Don't deploy from forks or unreviewed branches.

`compose_file` is the one exception. It is path-restricted (`[A-Za-z0-9._/-]+`, no `..` segments) so a typo or hostile commit cannot escape the single-quoted shell context where the value is interpolated.

## Why `.relay.yml` is re-read after `git pull`

`.relay.yml` is intentionally re-read **after** `git pull`, so config edits shipped in the same commit as the code they support take effect on the same deploy. This means a commit that *fixes* a broken `.relay.yml` lets the deploy through (post-pull pre-flight sees the fixed config), instead of gating on the stale pre-pull copy.

`pre_update` commands still run against the pre-pull tree (they may need pre-pull state to checkpoint). Rollback also keeps the pre-pull config, because `git reset --hard` restores the old tree where the old `compose_file` is on disk.

Command-mode deploys (`.relay.yml` with a `command:` field) run pre-flight *before* the command, since the command is opaque and has no natural post-pull checkpoint.

## Public vs authenticated endpoints

| Endpoint | Auth | Purpose |
|----------|------|---------|
| `GET /health` | None | Public liveness probe, no uptime |
| `GET /api/health` | Bearer | Authenticated health, includes uptime |
| All other `/api/*` | Bearer | Read or mutate state |

The MCP `/mcp` endpoint sits behind the same `AUTH_TOKEN`.
