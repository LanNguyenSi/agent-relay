# Log

<!-- Add new entries at the top, newest first. -->

- 2026-09-01T05:20:00Z, task 6dfb5708 doc pass: re-anchored citations in
  `exec-trust-boundary.md`, `deploy-phase-model.md`, and
  `path-containment-idiom.md` that shifted because of commit `1f58a19`
  (configurable `step_timeout_seconds` and an explicit `maxBuffer` in
  `runExec`/`runShell`, `stepExecOptions` in `engine.ts`). Also updated
  `exec-trust-boundary.md`'s prose for `runExec`/`runShell`'s new optional
  `opts` parameter. Left two pre-existing baseline citation mismatches in
  `deploy-phase-model.md` untouched — `engine.ts:408` (actually the
  `rollback: boolean` read lives further down, at what is now line 563) and
  `engine.ts:458-464` (now `captureContainerLogsTail`'s body, not
  `rollbackIfEnabled`'s call site) — both already stale before `1f58a19`
  from unrelated later commits, out of this task's scope; also left
  `exec-trust-boundary.md`'s `engine.ts:356-400`/`383-387`/`381` citations
  (the `runHealthCheck` section) untouched for the same reason, the actual
  content having moved to roughly lines 390-434/413-417/405 respectively at
  origin/main before this commit. Ran `okf-kit@0.3.1 check --json docs/okf`
  against this branch and against a clean `origin/main` checkout; no new
  finding was introduced by this branch (see task report for the diff).
- 2026-08-18T17:55:00Z, task 1074feb5 fix-round (MED-1/LOW-8): updated
  `deploy-failure-surfaces.md` — `rollbackApp` now returns the same
  `blocked`-style outcome as a deploy (`RollbackBlockedResult`, HTTP
  `{ result }`, MCP `ok(result)`, `recordDeploy` skipped on the blocked
  branch), correcting the prior "throws on failure instead, no
  blocked-style outcome" description. Also updated `deploy-phase-model.md`
  for the new `only` preflight-check-selection option both rollback call
  sites now use, and `docs/integration.md` for `POST /apps/:name/rollback`'s
  blocked response shape.
- 2026-07-16T05:58:10Z, CI now watches staleness: warn-only `okf-kit check`
  on every PR (`.github/workflows/okf-staleness.yml`, canonical pattern
  from harness#350).
- 2026-07-16T05:52:00Z, initial 6 docs authored and verified against
  sources at master `a15f5dd` (agent-relay, post PR #61): deploy-phase-model,
  exec-trust-boundary, path-containment-idiom, deploy-failure-surfaces,
  health-check-reality, apps-dir-contract (pointer). No BENCHMARK.md
  (operator decision). Also fixed a stale count in
  `docs/integration.md`: the preflight example JSON and the MCP
  `relay_preflight` section both claimed 6 checks; PR #61 added
  `apps_root_mount_congruence` and `compose_bind_mount_sources_exist`,
  bringing the total to 8 (`src/deploy/preflight.test.ts` "runs all 8
  checks"). The same edit corrected `git_remote_reachable`'s critical
  flag in the example JSON from `true` (wrong) to `false`, matching
  `src/deploy/preflight.ts`.
- 2026-07-16T05:50:00Z, bundle scaffolded (task 33072897, agent-tasks).
