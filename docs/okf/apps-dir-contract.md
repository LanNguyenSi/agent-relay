---
type: overview
title: APPS_DIR host/container contract — where the rule is documented
description: Pointer doc — the authoritative reference for the APPS_DIR host/container symlink contract is docs/operations.md; this entry only adds that install.sh's install-time symlink enforcement is a separate layer from the every-deploy preflight checks, and cross-refs which phase each check runs in.
tags: [apps-dir, install, preflight, pointer]
timestamp: 2026-09-01T06:41:00Z
sources:
  - docs/operations.md
  - src/deploy/preflight.ts
  - install.sh
---

# APPS_DIR host/container contract — pointer

The authoritative reference is [../operations.md](../operations.md#apps_dir-hostcontainer-contract) ("APPS_DIR host/container contract", current since PR #61): why the relay's Docker-outside-of-Docker setup requires the host's `/apps` and the relay's `APPS_DIR` to be the same directory, the two preflight checks that guard it, and the 2026-07-15 incident that motivated them. It is current against master and deliberately NOT restated here.

What that doc does not spell out, for code navigation:

- **`install.sh` enforces the SAME contract at install time**, as a separate layer from the every-deploy preflight checks (`install.sh:561-618`). When `APPS_DIR != /apps`, install either confirms an existing `/apps` symlink already resolves to `APPS_DIR`, creates the symlink if `/apps` doesn't exist yet, or fails loudly with an exact fix command if `/apps` exists as something else (a real directory, a plain file, or a symlink elsewhere) — it never silently overwrites. This is a one-time, install-time check; it does not run again on subsequent deploys.
- The two runtime checks that re-verify the same contract on **every** deploy are `apps_root_mount_congruence` and `compose_bind_mount_sources_exist` (`src/deploy/preflight.ts`). Which phase each one runs in, why, and why `force` cannot bypass either is in [deploy-phase-model.md](deploy-phase-model.md) — not restated here either.
