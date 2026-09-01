# Log

<!-- Add new entries at the top, newest first. -->

- 2026-09-01T06:41:00Z, task dd3cd90d re-anchor pass: re-verified all six
  content docs against sources at this repo's head (`b7a0f93`). Re-pointed
  `deploy-phase-model.md`'s three citations-resolve failures the
  step-timeout PR left stale (the entry below deliberately scoped them
  out): the `config.rollback` read (previously engine.ts line 408, now
  blank) resolves at `engine.ts:557`; the auto-rollback
  `runPreflightChecks({ phase: "all", force: true, only:
  ROLLBACK_CRITICAL_CHECKS })` call in `rollbackIfEnabled` (previously
  engine.ts lines 458-464) resolves at `engine.ts:569-575`; and the
  `only`-gated `tasks` array build in `runPreflightChecks` (previously
  preflight.ts lines 81-94, one line short of the array's actual start)
  resolves at `preflight.ts:82-94`. Also re-pointed two `engine.test.ts`
  citations in the same doc that had drifted without tripping
  citations-resolve (their old lines happened not to be blank, just
  content-wrong on re-verification against the test file): "rollback
  boolean honors pre-pull config, not post-pull" resolves at
  `engine.test.ts:446`; "rolls back using pre-pull compose_file when
  reload fails" resolves at `engine.test.ts:417-444`, its rationale
  comment now given as the full citation `engine.test.ts:433-435`
  (previously a bare line-range with no repeated filename, which risked
  being parsed as a continuation of the wrong prior citation). Re-pointed
  `path-containment-idiom.md`'s `safeAppDir` citations, flagged as a
  follow-up by the entry below: the function itself resolves at
  `apps.ts:144-222`; its lexical idiom check resolves at `apps.ts:151`;
  its post-realpath idiom re-check resolves at `apps.ts:218-220`; noted in
  prose that `safeAppDir` now routes the not-yet-deployed case through an
  intermediate dangling-symlink-chain fallback before reaching that
  re-check, without changing the two-idiom-application shape this doc
  describes. Also re-pointed the same doc's
  `checkComposeBindMountSourcesExist` span to `preflight.ts:402-531` (the
  function grew by eleven lines); its `assertComposeFileContained`
  citations in `relay.ts` were re-verified and needed no change.
  `apps-dir-contract.md`, `deploy-failure-surfaces.md`,
  `exec-trust-boundary.md`, and `health-check-reality.md` were
  re-verified claim by claim against their current sources (every cited
  span still contains the code the sentence describes) and needed no
  citation changes, only the timestamp bump below. Bumped all six docs'
  `timestamp` to `2026-09-01T06:41:00Z` (past every cited source's own
  last commit at this repo's head) to clear the `sources-fresh` warnings
  the CI job had flagged for `apps-dir-contract.md`,
  `deploy-failure-surfaces.md`, and `health-check-reality.md`, plus the
  further staleness this pass's own baseline check surfaced for
  `deploy-phase-model.md`, `exec-trust-boundary.md`, and
  `path-containment-idiom.md`. Ran `okf-kit@0.3.1 check --json docs/okf`:
  17 `sources-fresh` warnings / 0 errors before this pass, 0 warnings / 0
  errors after. Ran `okf-kit@0.8.0 check --json docs/okf`: 9 warnings (6
  `sources-fresh`, 3 `citations-resolve` blank-start-line) / 0 errors
  before, 0 warnings / 0 errors after.
- 2026-09-01T06:10:00Z, task 6dfb5708 review-round-2 fix pass: re-pointed
  `exec-trust-boundary.md`'s three citations that the entry below left
  stale: `runHealthCheck`'s old span now resolves at `engine.ts:384-460`,
  the `docker compose exec ... node -e` `runExec` call now resolves at
  `engine.ts:428-432`, and the trust-boundary comment above it now resolves
  at `engine.ts:420`; all three had drifted because of this commit's own
  further `engine.ts` edits (added `STEP_OUTPUT_MAX_CHARS`/`capStepOutput`
  before `runStep`, removed `MAX_BUFFER_MB`, fixed `stepExecOptions`'s
  truthiness check). Also re-pointed every `engine.ts` citation in
  `deploy-phase-model.md` that the entry below got right (each had shifted
  by -6 lines from this commit's own edits above `stepExecOptions`),
  landing at `engine.ts:105-110`, `engine.ts:205-207`, `engine.ts:57-66`,
  `engine.ts:112-120`, `engine.ts:98`, `engine.ts:191`, `engine.ts:243`,
  `engine.ts:253`, `engine.ts:264`, `engine.ts:273`, `engine.ts:288`,
  `engine.ts:352`, `engine.ts:362`, and `engine.ts:299`.
  `path-containment-idiom.md` cites only `apps.ts`/`relay.ts`/`preflight.ts`,
  none of which this commit touches, so it needed no changes (verified by
  reading each cited span). Left `deploy-phase-model.md`'s two pre-existing
  baseline mismatches untouched, same as the entry below (the
  `rollback: boolean`/`engine.ts:563` span and the
  `captureContainerLogsTail` doc-comment span, both out of this task's
  scope). Also noticed,
  but left untouched for the same reason (predates this task, `apps.ts` is
  not part of this change): `path-containment-idiom.md`'s citation for
  `safeAppDir` no longer resolves either (`safeAppDir` is now at
  `apps.ts:144`); flagged to the operator as a separate follow-up. Ran
  `okf-kit@0.3.1 check --json docs/okf` against three states of this repo:
  `origin/main` (1277ddb), baseline 14 `sources-fresh` warnings, 0 errors;
  a83e802 (previous commit on this branch, entry below), 8 warnings, 0
  errors; this commit, still 8 warnings, 0 errors, the same two docs/rule
  hits (`deploy-failure-surfaces.md`: `src/api/routes.ts`,
  `src/mcp/server.ts`, `src/services/apps.ts`, `CHANGELOG.md`;
  `health-check-reality.md`: `src/deploy/engine.ts`, `README.md`; both
  pre-existing `sources-fresh` staleness unrelated to this commit's own
  edits, none newly introduced).
- 2026-09-01T05:20:00Z, task 6dfb5708 doc pass, at a83e802 head: re-anchored
  citations in `exec-trust-boundary.md`, `deploy-phase-model.md`, and
  `path-containment-idiom.md` that shifted because of commit `1f58a19`
  (configurable `step_timeout_seconds` and an explicit `maxBuffer` in
  `runExec`/`runShell`, `stepExecOptions` in `engine.ts`). Also updated
  `exec-trust-boundary.md`'s prose for `runExec`/`runShell`'s new optional
  `opts` parameter. Left two pre-existing baseline citation mismatches in
  `deploy-phase-model.md` untouched, both already stale before `1f58a19`
  from unrelated later commits and out of this task's scope: the
  `rollback: boolean` read the doc labels one span for is actually at
  `engine.ts:563` at this commit's head, and the span the doc labels for
  `rollbackIfEnabled`'s call site is actually `captureContainerLogsTail`'s
  doc comment at this commit's head. Left `exec-trust-boundary.md`'s three
  `runHealthCheck`-section citations unchanged by mistake instead of
  re-pointing them to this commit's actual head locations (the
  `docker compose exec ... node -e` call and the trust-boundary comment
  above it); corrected by the entry above. Ran `okf-kit@0.3.1 check --json
  docs/okf` against this commit and against `origin/main` (1277ddb): 8
  `sources-fresh` warnings / 0 errors at this commit vs 14 warnings / 0
  errors at `origin/main`, no new finding introduced, all remaining
  warnings pre-existing `sources-fresh` staleness in
  `deploy-failure-surfaces.md` and `health-check-reality.md`.
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
