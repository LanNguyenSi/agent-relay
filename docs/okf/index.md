# Knowledge bundle index

Curated OKF knowledge bundle for the agent-relay repo. These docs capture
cross-file semantics, invariants, and known limitations that no single
source file or existing reference doc states on its own. For the
underlying feature references, see `docs/` one level up (`security.md`,
`operations.md`, `integration.md`) and the root `README.md`; these docs
deliberately do not duplicate them.

## Overview

- [APPS_DIR host/container contract](apps-dir-contract.md), pointer to the
  authoritative `docs/operations.md` section plus how install-time symlink
  enforcement relates to the every-deploy preflight checks.

## Modules

- [Health check reality](health-check-reality.md), the wired inline health
  check in `engine.ts` (fixed retries, docker-compose-exec probing) versus
  the fully-tested but unimported exponential-backoff module in
  `health.ts`, and the `README.md` description that matches the dead code.

## Invariants

- [Deploy preflight phase model](deploy-phase-model.md), which of the 8
  preflight checks run pre-pull vs post-pull vs both, why `force` cannot
  bypass the two APPS_DIR-congruence checks, and why rollback always
  reruns against the pre-pull (or pre-command) config, never the reloaded
  one.
- [Exec trust boundary](exec-trust-boundary.md), the `runExec`
  (execFile-argv) vs `runShell` (`/bin/sh -c`) split, and a residual not
  covered by `docs/security.md`: `config.health` string-interpolated into
  a `node -e` snippet, same trust tier as the documented shell fields but
  a different injection mechanism.
- [Path containment idiom](path-containment-idiom.md), the
  `resolve()` + `startsWith(root + sep)` pattern used at three call sites
  to avoid a sibling-prefix false positive, and an open question: two of
  the three sites also re-verify containment after `realpath()`
  (symlink-aware); the preflight bind-mount check does not.
- [Deploy failure surfaces](deploy-failure-surfaces.md), how a blocked
  deploy is represented differently across SSE (dedicated event),
  non-streaming HTTP (wrapped under `result`, PR #45), and MCP (plain
  `ok(result)`) — and the shared invariant that a blocked deploy never
  calls `recordDeploy`, so it never enters deploy history.
