# Security

agent-relay runs as a long-lived daemon on a VPS, with access to the Docker socket and to every app under `APPS_DIR`. Two trust boundaries matter.

## API authentication

All `/api` endpoints require `Authorization: Bearer <AUTH_TOKEN>`. The exception is `GET /health`: a public, unauthenticated relay-health probe (status + version, no uptime), suitable for external uptime monitors and load balancer probes.

The auth model is intentionally minimal: one bearer token, constant-time compared. No rate limits, no TLS termination, no mTLS. TLS is the responsibility of whatever sits in front of the relay (Traefik in `greenfield` / `existing-traefik` modes; nginx or Caddy in `port-only`). See [docs/operations.md](operations.md) for install modes.

In `greenfield` mode, the compose file written by `install.sh` also publishes `RELAY_PORT` (default 8222) on all host interfaces over plain HTTP, next to the Traefik route. Traefik routes to the relay only when `RELAY_DOMAIN` is set together with `TRAEFIK_EMAIL` or `TRAEFIK_CA=self-signed`. Otherwise the relay is reachable only over plain HTTP on that port. Block the port with a firewall rule that also applies to Docker-published ports, or use `existing-traefik`, or `port-only` with the default loopback bind.

## `.relay.yml` shell-exec trust boundary

The `command`, `pre_update`, and `post_update` fields in `.relay.yml` execute as **arbitrary shell** on the deploy host, as the relay user, with access to the Docker socket. The implicit trust boundary is therefore **push access to the deployed branch**: anyone who can land a commit that edits `.relay.yml` can run anything the relay user can run.

`health` is a fourth executable input, through a different mechanism: the relay embeds the value without escaping in a `node -e` fetch snippet that runs inside each running app container through `docker compose exec`, so a crafted `health` value runs arbitrary JavaScript in that container. It sits behind the same trust boundary (push access to the deploy branch).

Treat the deploy branch like a deploy key:

- Restrict who can push to it.
- Require code review for `.relay.yml` changes.
- Don't deploy from forks or unreviewed branches.

`compose_file` is the one exception. It is never shell-interpolated: it is passed as a literal argument to `docker compose` via an `execFile` arg array, so the charset regex (`[A-Za-z0-9._/-]+`) is path hygiene, not a shell-escape guard. Path traversal is contained separately by resolving the path and rejecting anything that lands outside `APPS_DIR`; `..` segments are therefore allowed as long as they stay under `APPS_DIR` (the legitimate sibling-app case `../other-app/docker-compose.yml`), while deeper escapes like `../../etc/passwd` are rejected. Absolute paths are rejected outright, and so is a symlink that resolves outside `APPS_DIR`.

`POST /api/self-update` (`src/deploy/self-update.ts`) follows the same `runExec` (`execFile` argv array) discipline: the optional `tag` body field is restricted to `"latest"` or `"main-<7..40 lowercase hex>"`, compose labels (`project`, `working_dir`, `config_files`, `service`) are validated and resolved under `working_dir`, and `docker inspect`, `docker pull`, `docker image inspect`, and the detached helper `docker run` invocation all pass discrete argument arrays to `runExec` without invoking a shell.

`step_timeout_seconds` is read from the same post-pull `.relay.yml`, so a pushed commit can also raise its own deploy's per-step exec timeout up to the 7200 s ceiling (`build`/`up`/`post_update`). This sits inside the trust boundary above rather than outside it: raising your own timeout is a strictly smaller capability than the arbitrary shell already granted by `command`/`pre_update`/`post_update`.

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
