---
type: invariant
title: Path containment idiom — resolve + startsWith(root + sep), and a lexical-only site
description: Three containment checks (safeAppDir, assertComposeFileContained, checkComposeBindMountSourcesExist) all use resolve()+startsWith(root+sep), never bare startsWith(root), to avoid a sibling-prefix false positive. Two of the three also re-verify containment after realpath() (symlink-aware); the preflight bind-mount check is lexical-only before stat(). Documented as an open limitation, not a confirmed exploit or an accepted design choice.
tags: [security, path-traversal, symlink, containment, preflight]
timestamp: 2026-07-16T05:52:00Z
sources:
  - src/services/apps.ts
  - src/config/relay.ts
  - src/deploy/preflight.ts
---

# Path containment idiom — resolve + startsWith(root + sep), and a lexical-only site

Three independent containment checks in this codebase share the same idiom, and each one's comment cross-references the pattern as shared:

```
const resolved = resolve(root, candidate);
const contained = resolved === root || resolved.startsWith(root + sep);
```

The `+ sep` is load-bearing. A bare `startsWith(root)` accepts a sibling directory whose name merely has `root` as a string prefix — `/apps` vs `/appsteak` is the canonical example named in all three sites' comments — because `"/appsteak/x".startsWith("/apps")` is `true` even though `/appsteak` is not under `/apps` at all. Appending the path separator before comparing (`/apps/`) rules that out: `/appsteak/x` does not start with `/apps/`. `resolved === root` is kept alongside the `startsWith` check to still accept the root directory itself (which has no trailing separator to match against).

## The three sites

1. **`safeAppDir`** (`src/services/apps.ts:28-47`). Validates an app name against `APP_NAME` regex, resolves it under `env.APPS_DIR`, applies the idiom (`:35`), then calls `realpath()` on both the candidate and `APPS_DIR` and re-applies the **same** idiom against the resolved real paths (`:41-44`) — "a symlink to a sibling-prefixed directory (e.g. `/apps/x -> /appsteak`) cannot escape" per its own comment.
2. **`assertComposeFileContained`** (`src/config/relay.ts:89-125`). Resolves `compose_file` against `appDir`, applies the idiom lexically first (`:99`, "catches `..` escapes and works before the compose file exists on disk"), then — if the resolved path exists (ENOENT is treated as "not on disk yet, presence is preflight's job" and short-circuits, `:113-117`) — calls `realpath()` on both sides and re-applies the idiom again (`:118-119`), specifically to catch "a symlink inside the app directory [that] can stay lexically contained while pointing outside APPS_DIR" (`:105-107`).
3. **`checkComposeBindMountSourcesExist`** (`src/deploy/preflight.ts:370-485`). Parses the compose file's bind-mount sources and applies the **same** idiom lexically, once, for both absolute sources (`:424-431`) and relative sources (`:436-446`) — its own comment explicitly says it "Mirrors the containment style in config/relay.ts's `assertComposeFileContained`" (`:411-413`). It then calls `stat(resolved)` (`:451`) purely to confirm existence. **There is no `realpath()` call anywhere in this function** — containment is checked once, lexically, against the pre-symlink-resolution path, and never re-verified against the real path before or after `stat()`.

## The asymmetry, and why it is left open here rather than resolved

Sites 1 and 2 both re-verify containment twice: once lexically (fast, works even when nothing exists on disk yet), once symlink-aware via `realpath()` (catches a symlink planted inside the already-lexically-contained directory that points back out). Site 3 only does the first half. Concretely: if a bind-mount source path resolves lexically to somewhere under `APPS_DIR`, but a path *component* of it is actually a symlink pointing outside `APPS_DIR` (the same shape of escape sites 1 and 2 exist specifically to catch), `checkComposeBindMountSourcesExist` would not detect it — `stat()` follows the symlink for its existence check, but the containment verdict was already decided lexically before that, and is never re-derived from the resolved real path.

This is stated here as an **open question / known limitation**, not as a confirmed exploit or as a deliberate, accepted design trade-off — no code comment, commit message, or test in `preflight.test.ts` indicates the omission was considered and intentionally accepted, and no working exploit path against it was constructed while writing this doc. It may simply be an oversight from timing: `assertComposeFileContained`'s `realpath()` re-check was itself a later addition (PR #44, v0.4.0) closing a gap the v0.1.1 release notes had explicitly filed as a follow-up ("Symlink containment in `compose_file` uses lexical `path.resolve`, not `realpath`", `9421be77`) — before PR #44, site 2 was lexical-only, exactly where site 3 still is. `checkComposeBindMountSourcesExist` was added later still (PR #61) and copied the lexical half of the now-established idiom without also picking up the realpath re-check that had by then landed at site 2. Whether it is worth closing depends on the threat model for who can shape a compose file's bind-mount sources: per `docs/security.md`, anyone who can land a `.relay.yml`/compose-file edit already has equivalent RCE through `command`/`pre_update`/`post_update`, so a symlink-based bind-mount escape may not grant a strictly new capability to that same actor — but that equivalence has not been verified either. Flagged here as something a maintainer should explicitly decide on, not silently carry forward.
