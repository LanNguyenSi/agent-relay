# Log

<!-- Add new entries at the top, newest first. -->

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
