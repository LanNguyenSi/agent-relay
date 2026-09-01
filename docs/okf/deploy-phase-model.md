---
type: invariant
title: Deploy preflight phase model — which checks run when, and rollback's config source
description: runPreflightChecks splits its 8 checks across pre-pull/post-pull/all phases by when each check has signal; force bypasses only non-critical checks; only (task 1074feb5) restricts the battery to named checks regardless of phase, skipping the excluded checks' runExec calls entirely rather than just discarding their results — both rollback gates use it to run only the two critical checks; rollback always reruns against prePullConfig/preCommandConfig, never the post-pull reloaded config, even when the new commit disabled rollback.
tags: [deploy, preflight, phases, rollback, force, only]
timestamp: 2026-09-01T05:20:00Z
sources:
  - src/deploy/preflight.ts
  - src/deploy/engine.ts
  - src/services/apps.ts
  - docs/security.md
---

# Deploy preflight phase model — which checks run when, and rollback's config source

`runPreflightChecks` (`src/deploy/preflight.ts:47-70`) does not always run all 8 checks. A `phase` option (`PreflightPhase = "pre-pull" | "post-pull" | "all"`, default `"all"`) selects a subset, because half the checks only have signal against one side of `git pull`.

## The 8 checks, by phase

Pre-pull (`phase === "pre-pull" || "all"`), against the tree as it sits before any pull:

- `git_clean` — non-critical.
- `git_remote_reachable` — non-critical.
- `apps_root_mount_congruence` — **critical**. Placed pre-pull deliberately: it has signal about the host/relay `APPS_DIR` view, not about the app's git tree, so pulling first buys nothing (`engine.ts:111-116`).

Post-pull (`phase === "post-pull" || "all"`), against the freshly-pulled tree and the reloaded `.relay.yml`:

- `compose_file_exists` — critical.
- `containers_running` — non-critical.
- `traefik_labels` — non-critical.
- `health_defined` — critical.
- `compose_bind_mount_sources_exist` — **critical**. Post-pull placement means a `.relay.yml`/compose fix that lands in the same commit as a new bind-mount path is checked against the tree that actually has it (`preflight.ts:356-364`).

`checkGitClean` and `checkGitRemoteReachable` are tautologies after a successful pull (a pull that succeeded already proves the tree is clean and the remote reachable), which is why the default flow runs them only pre-pull rather than in both slices — re-running them post-pull would just duplicate signal (`engine.ts:211-213`).

## Force: which checks it can skip, and why two can't be skipped

`runPreflightChecks` gates on **all** checks by default, or only **critical** checks when `force: true` (`preflight.ts:65-67`):

```
passed = force ? checks.filter(c => c.critical).every(c => c.passed) : checks.every(c => c.passed)
```

Four of the 8 are critical and survive `force`: `compose_file_exists`, `health_defined`, `apps_root_mount_congruence`, `compose_bind_mount_sources_exist`. The `DeployOptions.force` JSDoc (`engine.ts:63-72`) states the rationale for the two APPS_DIR checks explicitly: `compose_file_exists`/`health_defined` are critical because a deploy simply cannot succeed without them, but `apps_root_mount_congruence` and `compose_bind_mount_sources_exist` are critical for a different reason — letting either through **silently masks a deployed app's on-host config with an empty directory** (the 2026-07-15 incident class: the docker daemon auto-creates a missing bind-mount source as an empty directory rather than erroring) instead of merely failing the deploy. `force` is "I know what I'm doing, skip the git checks", not "let a mount mismatch corrupt my app's on-disk config" — those are different risk classes, so force's semantics deliberately does not extend to them (`engine.ts:118-126`).

## Rollback always uses the pre-pull (or pre-command) config, never the reloaded one

Every rollback call site passes the config captured **before** the mutating step it's rolling back from, not the config reloaded after `git pull` / the custom command:

- `defaultFlowDeploy` closes over `prePullConfig` (the parameter named `config` at `engine.ts:104`) and passes it to every `rollbackIfEnabled(prePullConfig, ...)` call (`engine.ts:197, 249, 259, 270, 279`) — including the post-health-check rollback, which runs *after* `config` (the post-pull reload) was used for the build/up/health steps themselves.
- `customCommandDeploy` does the same with `preCommandConfig` (`engine.ts:294`, calls at `358, 368`).

This is deliberate, not an oversight: `rollback: boolean` is read from whichever config is passed to `rollbackIfEnabled` (`engine.ts:408`), and the engine always passes the pre-mutation one on purpose. A commit that ships a broken app **and** flips `rollback: false` in the same commit does not get to disable its own safety net — the pre-pull value of `rollback` (from the last-known-good commit) governs whether the *current* deploy's rollback fires; the new `rollback: false` only takes effect starting with the *next* deploy. Regression-pinned by `src/deploy/engine.test.ts` "rollback boolean honors pre-pull config, not post-pull" (`engine.test.ts:304`). The same reasoning is why `rollbackIfEnabled`'s rebuild/restart steps use the pre-pull `compose_file` too: `git reset --hard` restores the OLD tree, where the OLD `compose_file` is the one on disk — regression-pinned by a separate test, "rolls back using pre-pull compose_file when reload fails" (`engine.test.ts:275-302`, rationale comment at `:291-293`).

## Rollback gates on `only` two checks, not `phase`'s whole battery

Both rollback call sites — `rollbackApp` (`services/apps.ts:377-383`) and
the auto-rollback path `rollbackIfEnabled` (`engine.ts:458-464`) — pass
`phase: "all", force: true` **and** `only: ROLLBACK_CRITICAL_CHECKS`
(`preflight.ts:72-76`), where `ROLLBACK_CRITICAL_CHECKS` is exactly
`["apps_root_mount_congruence", "compose_bind_mount_sources_exist"]`. `only`
(`PreflightOptions.only`, `preflight.ts:40-56`) is a third, independent
knob alongside `phase` and `force`: unlike `force` (which still runs every
check for the given phase and only changes how `passed` is computed), a
check name not in `only` is never pushed onto the `tasks` array at all
(`preflight.ts:81-94`) — its `runExec` call (each bounded by `exec.ts`'s
300s timeout) never fires.

This matters specifically for rollback because it's the emergency-restore
path: before `only` existed, both rollback gates ran the full 8-check
battery via `phase: "all"` (git status, git ls-remote, docker compose ps,
the mount-congruence `docker run` probe, …) before compose build/up could
restore the last-known-good containers, even though 6 of those 8 checks
either protect a `git pull` (which rollback never runs) or are non-critical
signal already thrown away by `force: true`. `only` makes that skip literal
instead of just discarding the results: `phase: "all"` still visits both
phase buckets (`apps_root_mount_congruence` is bucketed pre-pull,
`compose_bind_mount_sources_exist` post-pull — the same either/or split
described above), but within each bucket only a check whose name is in
`only` is started. `phase: "pre-pull"`/`"post-pull"` alone could not
express "exactly these two, spanning both buckets" — hence `phase: "all"`
stays required alongside `only`, not replaced by it. Regression-pinned by
`src/deploy/preflight.test.ts`'s "only parameter" describe block (checks
the excluded git/docker calls are never made, not just filtered from the
report) and by the `only` assertions in both `apps.test.ts`'s and
`engine.test.ts`'s rollback-preflight-gate tests.

## Command-mode deploys and the standalone/MCP preflight view

Command-mode (`.relay.yml` with a `command:` field) has no natural pre/post-pull split — the command is opaque, so `customCommandDeploy` runs preflight once, pre-command, with no `phase` argument (`engine.ts:305`), which defaults to `"all"`. The same default applies to the two read-only entry points that inspect current disk state without deploying: `runPreflight` in `src/services/apps.ts:178-182` (backing both the standalone `GET /api/apps/:name/preflight` HTTP route and the MCP `relay_preflight` tool) calls `runPreflightChecks({ appDir, config })` with no `phase`, so it always runs the full 8-check battery against whatever is on disk right now.

## What this doc does not restate

Why `.relay.yml` is re-read after `git pull` (so a commit that fixes a broken config takes effect the same deploy) is covered in [docs/security.md](../security.md#why-relayyml-is-re-read-after-git-pull) and not duplicated here.
