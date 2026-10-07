# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Fixed

- **The relay container no longer accumulates defunct `[git]` processes** (task 3713d624). Root cause: `node dist/index.js` ran as PID 1 with no init. Git's own detached auto-maintenance (`git maintenance run --auto --detach` after commit, push, fetch, pull) is the main source of the orphans, next to steps killed by their timeout. They are reparented to PID 1, and Node only reaps children it spawned itself, so they stayed defunct until the container restarted. The image now installs `tini` and runs it as the entrypoint (`-s`, subreaper), and `docker-compose.yml`, `docker-compose.prod.example.yml` and every compose variant `install.sh` generates set `init: true`. A 20-cycle container soak left 60 defunct processes before and 0 after; static tests pin the Dockerfile and compose settings. Upgrade: source-built compose files need `docker compose up -d --build`; installs created by `install.sh` need `docker compose pull && docker compose up -d` once the image is republished. Verify with `docker exec agent-relay ps -o pid,ppid,stat,comm`. Behaviour change: stop and recreate now end the relay immediately (SIGTERM reaches node, exit 143, no graceful drain); before, SIGTERM was ignored and Docker sent SIGKILL after about 10 s. See `docs/operations.md`.

### Added

- **Per-app `upstream` info on `GET /api/apps` and `GET /api/apps/:name`** (task 1aa41129). Each app reports `{ branch, deployedCommit, remoteHead, checkedAt, state, reason? }`, where `state` is `current`, `behind` (the deployed commit differs from the remote branch head) or `unknown` (remote unreachable, timed out, branch missing on the remote, detached HEAD; never `current` on doubt), so deploy-panel can flag stale apps without a manual SHA comparison. Read-only: only `git rev-parse` and `git ls-remote origin refs/heads/<branch>` run, never fetch or pull. The branch is the one a deploy pulls (the checkout's current branch). `ls-remote` has a 5 s timeout, at most 4 run at once, results (failures too) are cached in memory for 60 s, the app list waits at most 6 s and the single-app detail (also MCP `relay_status` with an app) at most 3 s before reporting `unknown` (check pending) for a slow remote or a full lookup queue. A result can lag the remote by up to the 60 s TTL in either direction. The field is additive; see `docs/integration.md`.
- `POST /api/apps/:name/deploy` (plain and `?stream=true`) and `POST /api/apps/:name/rollback` accept an optional caller-supplied deploy id via the `X-Deploy-Id` header or the `deployId` body field (1-128 chars of `[A-Za-z0-9._:-]`; header and body must match if both are sent). It is stored in the history entry and returned in `GET /api/deploys` and `recentDeploys`, so a client such as deploy-panel can tie an entry to its own deploy unambiguously. An invalid or mismatched id returns 400 before anything is deployed. Absent id: records are unchanged (no `deployId` field), and existing history files load as before. The MCP tools do not take an id.

## [0.5.0] - 2026-10-05

**Minor release: new APPS_DIR preflight checks, a per-step timeout, rollback gating and a rollback error phase, plus a symlink-containment hardening and CVE sweep.**

### Security

- **Lockfile and dependency bumps from the 2026-06 to 2026-09 CVE sweeps** (PRs #52, #55, #63, #65, #66, #67, #69, #71, #72, #82, #83, #88, #89). Closes the hono CORS advisory (wildcard origin with credentials), the js-yaml `!!omap` quadratic-CPU advisory, and advisories in protobufjs, vite, body-parser, type-is, fast-uri, qs, ip-address, brace-expansion, and nanoid (dev scope). `@hono/node-server` moves to 2.x (^2.0.5, closing GHSA-frvp-7c67-39w9) together with `@modelcontextprotocol/sdk` 1.30.0; the relay only uses `getRequestListener`, which is unchanged. `postcss` floor raised to ^8.5.18.
- **@grpc/grpc-js lockfile bump** (task 2342ef4f). @grpc/grpc-js 1.14.4 -> 1.14.5 (transitive via dockerode) closes GHSA-m9gg-hp2v-232j (high) and GHSA-f596-whhp-79r4 (low). Lockfile-only change, no `overrides` entry needed.
- **js-yaml, hono, vitest/@vitest/mocker lockfile bumps** (CVE sweep 2026-09-11). js-yaml 4.3.1 -> 4.3.2 closes GHSA-2883-xcg3-v3hh (HIGH). hono 4.13.0 -> 4.13.7 closes GHSA-gqvv-2mrq-wpjv, GHSA-g6gw-c38x-mqfc, GHSA-crvj-82cr-hjcx (moderate). vitest/@vitest/mocker/@vitest/coverage-v8 4.1.9 -> 4.1.11 closes GHSA-82fw-gwwq-j7x9 (moderate, dev dependency).

### Added

- **Two critical preflight checks enforce the APPS_DIR host/container contract** (PR #61). `apps_root_mount_congruence` (pre-pull) round-trips a random marker through a throwaway read-only `docker run` bind mount of `APPS_DIR`, proving the Docker daemon's host-side view and the relay's in-container view are the same directory, and fails closed with a host-symlink fix hint. `compose_bind_mount_sources_exist` (post-pull) parses the app compose file and fails when a bind-mount source under `APPS_DIR` is missing; named volumes, out-of-tree absolute paths and unresolved `${VAR}` sources are skipped with a note. Both close the incident class where a mismatched host `/apps` silently mounted empty directories over app config. `install.sh` now creates or verifies the host `/apps -> $APPS_DIR` symlink when `APPS_DIR` is not `/apps`, and fails with exact fix commands otherwise.
- **Rollback error bodies carry a `phase`** (task 994f6c81). `POST /api/apps/:name/rollback` error responses (400, and the 404 for a `.relay.yml` error) gain an additive `phase: "before_reset" | "after_reset"` field telling callers whether the rollback had reached `git reset --hard` (`after_reset`: a reset was attempted or succeeded, including one that failed part-way) or failed before touching the working tree (`before_reset`: unknown app, or a ref that fails `git rev-parse --verify`). Status codes and every other field are unchanged; a ref that fails the verify now reports `Rollback failed: unknown commit '<ref>': <git stderr>`.
- **Configurable per-step exec timeout, an explicit 16 MiB per-stream `maxBuffer`, and a stored-output cap** (task 6dfb5708). `.relay.yml` gains an optional `step_timeout_seconds` (1-7200) that overrides the deploy engine's per-step timeout for `pre_update`, `git pull`, `compose build`/`up`, `post_update`, `command`, and rollback `compose build`/`up`; the default timeout is unchanged (300 s) when the field is absent. Separately, `runExec`'s stdout/stderr buffer cap is now explicit at 16 MiB per stream instead of relying on Node's own 1 MB default, after a deploy build hit the 300 s cap without enough diagnostic signal in the truncated output. A step killed by either limit now appends a `[relay] ...` line to its output naming the reason (timeout or buffer overrun) instead of leaving a bare non-zero exit for the operator to interpret. A step's stored output (what the deploy API's JSON response, the SSE stream, and the MCP `relay_deploy` result all carry) is separately capped at 200,000 characters, keeping the last 200,000 with a truncation notice, since the per-stream buffer cap alone does not bound the combined stdout+stderr text kept on a `DeployStep`.

### Fixed

- **Rollbacks are gated on the critical preflight checks** (PR #73). Both rollback paths (auto-rollback after a failed deploy and the standalone rollback endpoint and MCP tool) now run `apps_root_mount_congruence` and `compose_bind_mount_sources_exist` before `compose build`/`up`; non-critical checks are reported but do not block, since a rollback never runs `git pull`. A blocked rollback returns a structured `blocked: true` result with the `preflight` report over HTTP and MCP, and the auto-rollback step message is prefixed `ROLLBACK BLOCKED`.
- **Health-check failures carry diagnostics, and rollback steps stream live** (PR #75). A failed health check now appends the last probe's HTTP status or error and a capped `docker compose logs --tail` excerpt to the step output. Rollback steps are emitted through the SSE `onStep` stream as they happen instead of only in the final result, so a dropped connection no longer hides that a rollback ran.
- **`safeAppDir` containment closes symlink escapes** (PRs #64, #68, #70). Both sides of the `APPS_DIR` check are normalized the same way (a symlinked `APPS_DIR` parent such as macOS `/var` no longer false-positives as an escape); a dangling top-level symlink that points outside `APPS_DIR` is rejected; symlink targets are resolved top-down so chained dangling symlinks and lexical `..` collapse over an out-pointing symlink no longer pass the check.
- **`compose_bind_mount_sources_exist` resolves `APPS_DIR` via realpath** (PR #76). With `APPS_DIR` behind a symlink, every relative bind source was skipped as an escape and the critical check reported passed with zero sources checked.
- **Streaming deploy returns 404 for an unknown app or invalid `.relay.yml`** (PR #58). `POST /api/apps/:name/deploy?stream=true` now resolves the config before opening the SSE stream, so a `RelayConfigError` is a real 404 like the non-streaming path instead of an SSE error event over HTTP 200. A `RelayConfigError` raised after the stream has opened stays an in-stream error event.
- **Runtime image ships the docker buildx plugin** (`docker-cli-buildx`, about 90 MB of image size). Compose v5 in the `node:22-alpine` image found no buildx plugin, printed "Docker Compose requires buildx plugin to be installed" and fell back to the legacy builder, which cannot reuse the BuildKit layer cache. App builds that completed in under a minute with cache rebuilt from scratch and hit the 300 s `runExec` step timeout, failing the deploy before `git pull`. CI now asserts the plugin is present in the built image. Existing relays must be recreated from the republished `:latest` image to pick this up (PR #77).

### Changed

- The unused `src/deploy/health.ts` module (and its test) is removed and the README and OKF docs now describe the in-container health check the deploy engine actually runs (PR #71). No behavior change.
- CI: `release.yml` and `publish.yml` now pass step values into `run:` scripts through `env:` and shell variables instead of interpolating `${{ }}` expressions into the script text. No behavior change for normal tags and versions.

## [0.4.0] - 2026-06-16

**Minor release: two installer features plus a HIGH-severity security and hardening sweep.** New: a non-root install path and a `TRAEFIK_CA` override for alternative TLS providers. Security: @grpc/grpc-js 1.14.4 closes CVE-2026-48068/48069 (HIGH), esbuild 0.28.1 closes GHSA-gv7w-rqvm-qjhr (HIGH), plus symlink and prefix-escape hardening in the deploy engine.

### Security

- **HIGH: @grpc/grpc-js upgraded to 1.14.4, esbuild to 0.28.1** (PR #46). Closes CVE-2026-48068 and CVE-2026-48069 in grpc-js (HIGH) and GHSA-gv7w-rqvm-qjhr in esbuild (HIGH).
- **Realpath-based symlink containment for `compose_file`** (PR #44). The previous approach resolved the path lexically and checked for `..` segments but did not follow symlinks. The check now calls `fs.realpath()` and verifies the resolved path stays inside the expected directory, closing a defense-in-depth gap noted in the v0.1.1 release notes.
- **`safeAppDir` prefix check hardened against sibling-prefix escape** (PR #43). A `startsWith(appDir)` check without a trailing separator would accept `apps-evil` as a sub-path of `apps`. The separator is now appended before comparing.

### Fixed

- **Blocked deploy response now wrapped under `result`** (PR #45). `DeployBlockedResult` was previously returned at the top level while all other response types nest their payload under `result`, causing shape-based callers to misidentify blocked responses.
- **SC2317 shellcheck warning silenced on the `install.sh` source-only guard** (PR #49). The warning was a false positive triggered by the guard pattern that prevents double-sourcing.

### Changed

- **`execFile`-style argument arrays replace shell-interpolated command strings for docker and git calls in the deploy engine** (PR #47). Passing discrete argument arrays to `execFile` removes a class of shell-injection surface from the deploy path.

### Added

- **Non-root install path via `HOME`-based `RELAY_DIR` and `APPS_DIR`** (PR #48). `install.sh` now supports installing without `sudo` by defaulting directories under the invoking user's home when root is not available or not wanted.
- **`TRAEFIK_CA` env var for alternative TLS providers** (PR #50). Operators using staging, pebble, or self-signed CAs can override the default Let's Encrypt CA URL without patching `install.sh`.

## [0.3.0] - 2026-06-09

Security release closing the 2026-05-30 audit findings and a multi-CVE dependency sweep, plus a deploy-preflight phase split. The headline security fix is a HIGH command injection in the deploy path. The relay is deployed as a GHCR container; this tag publishes the image and a GitHub Release.

### Added

- **Deploy preflight runs in two phases, `pre-pull` and `post-pull`** (commit 76858d5). Moving preflight entirely post-pull (PR #21) had turned `git_clean` and `git_remote_reachable` into tautologies in the default flow (a successful `git pull` already proves both) and meant a dirty working tree could no longer block a deploy before `git pull` clobbered the operator's WIP. `runPreflightChecks` gains a `phase: "pre-pull" | "post-pull" | "all"` argument; the default deploy flow now runs `git_clean` + `git_remote_reachable` before `git pull` (blocking a dirty-tree deploy before any working-tree mutation) and the remaining checks after reloading `.relay.yml`, before the compose build.

### Security

- **HIGH: command injection in the deploy branch parameter** (PR #39). The `branch` parameter from HTTP and MCP deploy callers flowed unvalidated into a shell-interpolated `git pull origin '<branch>'`, so a crafted value could break out of the single-quote wrapping and execute arbitrary commands on the host. A new `BRANCH_NAME` regex and exported `validateBranch()` helper (mirroring the existing `validateCommitRef` / `validateServiceName` guards) now validate the branch at both deploy entrypoints (`deployApp` and `deployAppStreaming`) before it reaches `deploy()`.
- **MEDIUM: constant-time bearer-token comparison** (PR #41, finding #16). Both auth sites (HTTP API and MCP) now compare the bearer token with a shared `node:crypto` `timingSafeEqual` helper, fulfilling the constant-time guarantee documented in `docs/security.md`.
- **protobufjs pinned to `^7.5.8` via `overrides`** to patch 8 transitive CVEs (PR #37).
- **CVE sweep** (lockfile resolutions and `overrides`, not direct-range bumps): `fast-uri`, `ip-address`, and `express-rate-limit` advanced and `hono` resolved to `4.12.23` in the lockfile for 4 MEDIUM CVEs (PRs #36 and #40; hono's direct range stays `^4.7.9`), `qs` resolved to `6.15.2` (CVE-2026-8723, PR #38), and `postcss` + `uuid` pinned via `overrides` to clear GHSA advisories (PR #32).

### Fixed

- **The relay reports its version from `package.json` at runtime** (PR #34), instead of a hardcoded string that could drift.

### Documentation

- **Open source surface added** (Code of Conduct, contributing, security policy, templates; PR #35) and the README restructured into `docs/` with a 60-second hook (PR #33).

## [0.2.0] - 2026-04-24

**Headline: adaptive installer + GHCR publishing.** This release makes
`install.sh` adapt to whatever the VPS already runs instead of
assuming a greenfield host, ships the Docker image to GHCR on every
merge so fresh installs can actually `docker pull`, and adds three
hardening steps catching broken installs before they hit production.

### Added

- `install.sh` v0.3.0 (partial) — second-wave hardening, three of the five sub-features land here. Non-root install and alternative TLS providers are tracked as separate follow-up tasks.
  - **Post-install health probe.** After `docker compose up -d` the installer now polls the relay's `/health` endpoint via `docker exec` (so all three modes work, including `existing-traefik` where the port isn't published on the host). 15-second ceiling. On timeout prints `docker ps` + last 20 log lines + exits non-zero so deploy-panel's wizard surfaces broken installs cleanly instead of reporting success for a crashed container.
  - **Firewall preflight warning.** Detects an active UFW on the host and compares the allowed ports against what the resolved install mode needs (80/443 for greenfield / existing-traefik; `RELAY_PORT` for port-only with a non-loopback bind). If any are missing, prints a targeted `sudo ufw allow …` command. Never auto-runs — firewall mutation without explicit consent is too aggressive for a one-shot installer. firewalld / iptables detection is deliberately out of scope for this pass.
  - **`RELAY_FORCE_RECREATE=1`.** Opt-in cleanup for a broken previous install. When set, removes any pre-existing `agent-relay` container before compose up, so a half-dead container from a prior failed install can't block the new one on port conflict. Without the flag, if the installer sees an unhealthy `agent-relay` container it suggests setting `RELAY_FORCE_RECREATE=1` so the operator can recover without SSHing in to clean up by hand.

- `.github/workflows/publish.yml` — builds and pushes `ghcr.io/lannguyensi/agent-relay` on every merge to `main` (tags `:latest` + `:main-<sha>`) and on `v*` tag pushes (tags `:<version>`, `:<major.minor>`, `:latest`). Closes the gap that made `install.sh` fail with "denied" on every fresh VPS — the image had been referenced from day one but never actually published. Single-arch `linux/amd64` for now; arm64 is a follow-up.
  - **One-time operator action required after the first workflow run:** flip the package visibility from Private (GitHub default) to Public at `https://github.com/users/LanNguyenSi/packages/container/agent-relay/settings`. Without this, `install.sh` still errors with "denied" even though the image exists. Only needed once — subsequent pushes keep the existing visibility.
- `install.sh` — the docker-pull step is now loud instead of silently swallowing stderr. A failed pull surfaces an actionable error that names the likely cause (visibility not set to Public) and links to the settings page, instead of the misleading "will build locally if available" warning (the generated compose file has no `build:` field).
- `install.sh` v0.2.0 — adaptive install modes. New `RELAY_MODE` env var with four values:
  - `auto` (default) detects what's on :80 and picks one of the concrete modes.
  - `greenfield` — prior behaviour (creates Traefik + `traefik-public` + LE).
  - `existing-traefik` — joins an existing Traefik via `TRAEFIK_NETWORK` (default `traefik-public`) and `TRAEFIK_CERTRESOLVER` (default `letsencrypt`); does not create Traefik or networks.
  - `port-only` — no Traefik, no TLS; relay binds `RELAY_BIND:RELAY_PORT` directly (default `127.0.0.1`).
  - When auto-detection finds a non-Traefik listener on :80 **and** `RELAY_DOMAIN` is set, the installer refuses with an actionable banner (free the port, pick `port-only`, or pick `existing-traefik` with overrides) rather than silently producing a broken install. Motivation was a wizard install against a VPS where `memory-weaver-nginx` owned :80 — the old greenfield-only install died on `Bind for 0.0.0.0:80 failed`.
- Connection-info block now prints a `Mode:` line above `URL:` / `Token:` so operators see which path was taken. `URL:` / `Token:` label shapes are unchanged so deploy-panel's `parseInstallOutput` keeps working across all modes.
- `SKIP_TRAEFIK=1` is aliased to `RELAY_MODE=port-only` as a back-compat shim for anyone scripting against the old env surface.

## [0.1.1] - 2026-04-24

### Changed

- **Pre-flight now runs AFTER `git pull` + `.relay.yml` reload.** Default-flow deploys previously invoked pre-flight in `services/apps.ts` before the engine had a chance to pull. That meant a commit that *fixed* a broken `.relay.yml` (wrong `compose_file`, missing `command:` field, etc.) would keep failing on every first-deploy-after-merge because pre-flight saw the stale pre-pull copy — operators had to SSH in and run `git pull` by hand before the fix applied. Pre-flight is now a step inside `defaultFlowDeploy` that runs against the post-pull config, with a corresponding `preflight` entry in the SSE step stream. Command-mode deploys keep pre-flight pre-command (the command is opaque). Failure returns a new `DeployBlockedResult` shape; the API contract (`{ success: false, blocked: true, preflight }`) is preserved.
- **`compose_file` containment moved from lexical `..`-ban to filesystem-aware check.** The lexical ban blocked legitimate sibling-app patterns like `compose_file: ../project-forge/docker-compose.yml` (used by agent-planforge to route its panel deploy through project-forge's compose stack). `assertComposeFileContained` now resolves the value against `appDir` at load time and verifies the result stays under `resolve(appDir, "..")` — accepts sibling apps while still rejecting `../../etc/passwd` and embedded traversals. `startsWith(appsDir + sep)` guard prevents a sibling-name-prefix false positive (`apps` vs `appsteak`). Regex + absolute-path bans remain at parse time.
- `customCommandDeploy` re-reads `.relay.yml` after the command step so post-command config changes apply on the same run, matching the default-flow behaviour.

### Added

- `DeployOptions.force` (boolean). Propagates the HTTP API's existing `?force=true` query-param into pre-flight so non-critical checks can be skipped — identical semantics to what `services/apps.ts` did before the move.
- `compose_file` zod schema gains a shell-char regex + absolute-path rejection at parse time.

### Fixed

- vitest `include` now restricts to `src/` so compiled tests under `dist/` aren't picked up after `npm run build`, avoiding a double-run under CI.

### Notes

- `checkGitClean` and `checkGitRemoteReachable` become tautologies in default-flow pre-flight (a successful pull proves both). They stay meaningful for command-mode deploys and for the standalone `GET /api/apps/:name/preflight` endpoint. A clean pre-/post-pull split is filed as a follow-up.
- Symlink containment in `compose_file` uses lexical `path.resolve`, not `realpath`. Matches the threat model (push access to `.relay.yml` already grants RCE via `command:`/`pre_update`/`post_update`), but filed as defense-in-depth follow-up (`9421be77`).

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
