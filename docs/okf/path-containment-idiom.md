---
type: invariant
title: Path containment idiom — resolve + startsWith(root + sep), with symlink-aware re-verification
description: Three containment checks (safeAppDir, assertComposeFileContained, checkComposeBindMountSourcesExist) all use resolve()+startsWith(root+sep), never bare startsWith(root), to avoid a sibling-prefix false positive. safeAppDir and assertComposeFileContained re-verify both sides after realpath(); checkComposeBindMountSourcesExist re-verifies only APPS_DIR itself via realpath() (ENOENT fallback) so it compares like with like against the already-real appDir, while the candidate source path stays lexical before stat(). The source-side realpath question remains documented as open.
tags: [security, path-traversal, symlink, containment, preflight]
timestamp: 2026-09-01T06:56:00Z
sources:
  - src/services/apps.ts
  - src/config/relay.ts
  - src/deploy/preflight.ts
---

# Path containment idiom — resolve + startsWith(root + sep), with symlink-aware re-verification

Three independent containment checks in this codebase share the same idiom, and each one's comment cross-references the pattern as shared:

```
const resolved = resolve(root, candidate);
const contained = resolved === root || resolved.startsWith(root + sep);
```

The `+ sep` is load-bearing. A bare `startsWith(root)` accepts a sibling directory whose name merely has `root` as a string prefix — `/apps` vs `/appsteak` is the canonical example named in all three sites' comments — because `"/appsteak/x".startsWith("/apps")` is `true` even though `/appsteak` is not under `/apps` at all. Appending the path separator before comparing (`/apps/`) rules that out: `/appsteak/x` does not start with `/apps/`. `resolved === root` is kept alongside the `startsWith` check to still accept the root directory itself (which has no trailing separator to match against).

## The three sites

1. **`safeAppDir`** (`src/services/apps.ts:144-222`). Validates an app name against `APP_NAME` regex, resolves it under `env.APPS_DIR`, applies the idiom (`:151`), then calls `realpath()` on both the candidate and `APPS_DIR` and re-applies the **same** idiom against the resolved real paths (`:218-220`) — "a symlink to a sibling-prefixed directory (e.g. `/apps/x -> /appsteak`) cannot escape" per its own comment. The candidate side's realpath now goes through an intermediate dangling-symlink-chain fallback for the not-yet-deployed case, and that fallback applies the idiom a THIRD time (`src/services/apps.ts:203-205`): when the dangling top-level entry is itself a symlink, it resolves the link's target and rejects an escape there, before the post-realpath re-check at `:218-220` is ever reached.
2. **`assertComposeFileContained`** (`src/config/relay.ts:95-131`). Resolves `compose_file` against `appDir`, applies the idiom lexically first (`:105`, "catches `..` escapes and works before the compose file exists on disk"), then — if the resolved path exists (ENOENT is treated as "not on disk yet, presence is preflight's job" and short-circuits, `:119-123`) — calls `realpath()` on both sides and re-applies the idiom again (`:124-125`), specifically to catch "a symlink inside the app directory [that] can stay lexically contained while pointing outside APPS_DIR" (`:111-113`).
3. **`checkComposeBindMountSourcesExist`** (`src/deploy/preflight.ts:402-532`). Parses the compose file's bind-mount sources. Since `appDir` is already realpath-ed (from `safeAppDir()`), it resolves `APPS_DIR` with `realpath()` once (with ENOENT fallback to lexical), then applies the idiom against this resolved `APPS_DIR` for both absolute and relative sources. This avoids a lexical-vs-realpath mismatch when `APPS_DIR` itself contains a symlink (e.g., `/apps -> /private/apps` on macOS).

## Open questions

Earlier versions raised whether bind-mount **sources** themselves (not just `APPS_DIR`) should also be re-verified via `realpath()` to catch symlinks planted inside bind-mount source directories that point outside the checked boundary. That remains an open design question; the current approach validates containment of the source path itself via the idiom, with stat() confirming existence/accessibility, but does not traverse symlinks inside the source directory.
