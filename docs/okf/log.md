# Log

<!-- Add new entries at the top, newest first. -->

- 2026-09-02T05:04:08Z, task `44ee799a` fleet pin sweep: the okf-staleness
  workflow pin moved from okf-kit@0.8.0 to 0.9.0 for parity with the other
  bundle repos, and the header note that treated a pin mismatch as expected
  went with the mismatch. Measured on the committed tree before and after:
  `okf-kit check --json docs/okf` reports 0 errors, 0 warnings, 0 notices
  at 0.8.0 and at 0.9.0, so no doc needed a re-point or a re-stamp.

- 2026-09-01T06:56:00Z, task dd3cd90d review round 2 fix pass: reviewer
  hand-audited all 70 citation tokens across the six content docs (not just
  `citations-resolve`'s blank/non-blank check) and found four citations in
  `deploy-phase-model.md` that resolved to non-blank but content-wrong code
  behind the entry below's fresh timestamp, plus three lower-severity
  issues. Re-pointed all four: `runPreflightChecks` (previously
  `preflight.ts:47-70`, which lands on the function's JSDoc prose, not the
  function) now cites the function itself at `preflight.ts:77-102`; the
  `force` gate expression (previously `preflight.ts:65-67`, one line short
  of the `passed = force ? ...` statement) now cites `preflight.ts:97-99`;
  the post-pull-placement rationale for `compose_bind_mount_sources_exist`
  (previously `preflight.ts:356-364`, the tail of
  `checkAppsRootMountCongruence`) now cites the actual rationale comment at
  `preflight.ts:388-401`; and `runPreflight` (previously
  `apps.ts:178-182`, inside `safeAppDir`'s dangling-symlink comment) now
  cites the function itself at `apps.ts:415-419`. Also fixed, same round:
  (1) `path-containment-idiom.md`'s `safeAppDir` entry named only two
  applications of the containment idiom (`apps.ts:151`, `apps.ts:218-220`);
  `apps.ts` around line 203 applies it a third time, inside the
  dangling-symlink-chain branch reached when the not-yet-deployed candidate
  resolves to a dangling top-level symlink, rejecting an escape there
  before the post-realpath re-check at `apps.ts:218-220` is ever reached;
  named now, with citation `apps.ts:203-205`. (2)
  `.github/workflows/okf-staleness.yml`'s "canonical
  pattern ... keep them in sync" header comment reads as a parity claim
  across the five OKF bundle repos; this repo is currently the only one
  pinned to okf-kit@0.8.0, so added a line noting the pin here can lead the
  others until a fleet-wide sweep brings them back in sync, not drift to fix
  in this repo. (3) Off-by-one: `checkComposeBindMountSourcesExist` spans
  `preflight.ts:402-532` (532 is the closing brace), not `402-531` as cited
  in `path-containment-idiom.md` and in the entry below; corrected both to
  `402-532`. Also verified and tightened `apps-dir-contract.md`'s
  `install.sh` citation for the install-time symlink-enforcement block: the
  previous `install.sh:561-618` was loose (561 is an unrelated `mkdir -p`
  two lines above the actual guard, and 618 is inside the guard's last
  branch, three lines short of its closing `fi`); tightened to
  `install.sh:573-621`, the exact span from the
  `if [ "$APPS_DIR" != "/apps" ]` guard line to its matching `fi`. (4) The
  bare `352, 362` line-number pair in `deploy-phase-model.md` (no repeated
  filename, risked being parsed as a continuation of the prior citation) is
  now `engine.ts:352`, `engine.ts:362`; both call sites re-verified
  unchanged (`rollbackIfEnabled(preCommandConfig, ...)`). The list-form
  citation `engine.ts:191, 243, 253, 264, 273` a few lines above is
  retained in that form, deliberately: all five numbers were re-verified as
  `rollbackIfEnabled(prePullConfig, ...)` call sites, and the list
  immediately follows the sentence naming that one call, unlike the
  `352, 362` pair, which sits two sentences after a different citation
  (`engine.ts:288`) for a different function and so read as ambiguous
  without a repeated filename. Bumped `deploy-phase-model.md`,
  `path-containment-idiom.md`, and `apps-dir-contract.md`'s `timestamp` to
  `2026-09-01T06:56:00Z`; the other three content docs were not touched
  this round. Correcting the entry below's opening claim: round 1
  re-verified and re-pointed the citations its own `citations-resolve`
  tooling run flagged as blank, across all six content docs; it did not
  catch the four resolving-but-wrong `deploy-phase-model.md` citations
  above, which review in this round found and fixed. That is not a
  clean-sweep claim for this round either: this round rechecked only the
  specific citations review flagged, not every one of the 70 tokens against
  its source again from scratch. Ran `okf-kit@0.3.1 check --json docs/okf`:
  0 warnings / 0 errors (unchanged from the entry below; this round's
  defects were all content-wrong citations that `citations-resolve` cannot
  detect, not blank-target ones). Ran `okf-kit@0.8.0 check --json docs/okf`:
  0 findings (also unchanged, same reason).
- 2026-09-01T06:41:00Z, task dd3cd90d re-anchor pass: re-verified and
  re-pointed the citations this pass's `citations-resolve` tooling run
  flagged as blank, across all six content docs against sources at this
  repo's head (`b7a0f93`); see the entry above for four further
  `deploy-phase-model.md` citations that resolved to non-blank but
  content-wrong code, not caught by this pass, found and fixed by review.
  Re-pointed
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
  `checkComposeBindMountSourcesExist` span to `preflight.ts:402-532`
  (corrected from `402-531` by the entry above, an off-by-one against the
  function's actual closing brace); its `assertComposeFileContained`
  citations in `relay.ts` were re-verified and needed no change.
  `apps-dir-contract.md`, `deploy-failure-surfaces.md`,
  `exec-trust-boundary.md`, and `health-check-reality.md` were
  re-verified claim by claim against their current sources (every cited
  span still contains the code the sentence describes) and needed no
  citation changes, only the timestamp bump below (as originally stated;
  the entry above later tightened `apps-dir-contract.md`'s `install.sh`
  span, so that claim no longer holds for that file). Bumped all six docs'
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
