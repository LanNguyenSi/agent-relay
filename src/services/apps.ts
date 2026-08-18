import { resolve, sep, dirname, basename, isAbsolute } from "node:path";
import { readdir, stat, lstat, readlink, realpath } from "node:fs/promises";
import { env } from "../config/env.js";
import { loadRelayConfig, RelayConfigError } from "../config/relay.js";
import { deploy } from "../deploy/engine.js";
import { runPreflightChecks, type PreflightReport } from "../deploy/preflight.js";
import { runExec } from "../deploy/exec.js";

// Preflight used to run here before git pull. That meant a commit that
// *fixed* a broken .relay.yml (wrong compose_file, missing `command:`,
// etc.) failed preflight against the still-broken pre-pull copy on
// disk — the merged fix couldn't be applied. Preflight now runs inside
// the deploy engine (`deploy/engine.ts`) against the post-pull config
// for default-flow deploys; command-mode deploys keep the pre-command
// preflight since the command is opaque. Operators who need the
// standalone preflight view (e.g. the ops dashboard) use
// `runPreflight(name)` below, which still reads the current working
// tree.

export { RelayConfigError };

// realpath() requires every path segment to exist, so it can't tell us where
// a DANGLING symlink's target really is. This walks up to the nearest
// existing ancestor, resolves *that* (following any symlinks in it, e.g. a
// symlinked APPS_DIR parent), then rebuilds the missing tail on top —
// the one-level fallback safeAppDir applies to `appsRoot` itself,
// generalized to arbitrary depth so it also normalizes a dangling
// symlink's own target path before it's compared against `appsReal`. Fed a
// RAW (not pre-collapsed via path.resolve()) path string, this also
// resolves a `..` that follows a symlink in kernel order rather than
// lexically — see resolveSymlinkChain below, which is what supplies that
// raw string.
// The rebuilt parent segment can ITSELF be a (possibly still dangling)
// symlink — e.g. apps/mid -> <outside> (dangling) with apps/danger ->
// "mid/tail": once the recursion bottoms out at the real APPS_DIR and
// reattaches "mid", that reattached "mid" is a real on-disk dirent again,
// and lstat can tell us it's a symlink even though it doesn't resolve.
// Left unchecked, the tail ("tail") would be lexically appended onto that
// symlink's OWN path instead of onto where it actually points, which is
// exactly the chained-dangling-symlink and dangling-`..`-target escapes
// (see safeAppDir's task d39b85ce follow-up). So before reattaching the
// next segment we lstat the rebuilt parent and, if it's a symlink, route
// it through resolveSymlinkChain (mutually recursive with this function)
// BEFORE appending — resolving the chain segment by segment in kernel
// order, one hop per actual symlink followed. `depth` is the shared
// MAX_SYMLINK_DEPTH budget from resolveSymlinkChain, threaded through so a
// manufactured cycle across this mutual recursion still terminates.
// The root side deliberately KEEPS its one-level fallback: if APPS_DIR
// itself does not exist there is nothing inside it to check, so the two
// sides intentionally do not share this helper.
async function bestEffortReal(path: string, depth = 0): Promise<string> {
  try {
    return await realpath(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    const parent = dirname(path);
    if (parent === path) return path; // reached filesystem root
    const parentReal = await bestEffortReal(parent, depth);
    // Same tolerant posture as resolveSymlinkChain's own lstat below: a
    // non-ENOENT error here is treated as "not a symlink" and falls through
    // to the plain lexical reattach, rather than propagating an errno.
    const parentLink = await lstat(parentReal).catch(() => null);
    if (parentLink?.isSymbolicLink()) {
      if (depth >= MAX_SYMLINK_DEPTH) {
        const loopErr = new Error("Too many levels of symbolic links") as NodeJS.ErrnoException;
        loopErr.code = "ELOOP";
        throw loopErr;
      }
      const parentTarget = await readlink(parentReal);
      const resolvedParent = await resolveSymlinkChain(dirname(parentReal), parentTarget, depth + 1);
      return resolve(resolvedParent, basename(path));
    }
    return resolve(parentReal, basename(path));
  }
}

// SYMLOOP_MAX analog: bounds how many hops resolveSymlinkChain will follow
// through a manufactured chain of individually-dangling symlinks. A single
// fully-materialized chain is already bounded by the kernel's own ELOOP
// detection inside bestEffortReal's realpath() call; this guards the case
// that detection can't see — each hop below is a SEPARATE readlink() +
// realpath() round trip (not one syscall spanning the whole chain), so a
// sufficiently long or cyclic manufactured chain would otherwise recurse
// without the kernel ever getting to count it in a single lookup.
const MAX_SYMLINK_DEPTH = 40;

// Resolves a symlink's target (`raw`, as read via readlink()) to its
// best-effort real location, starting from the directory (`base`) the
// symlink itself lives in. Together with bestEffortReal's own
// parent-symlink check above (mutually recursive with this function), this
// closes the escape variants measured against task d39b85ce's follow-up
// review, segment by segment in kernel order, up to MAX_SYMLINK_DEPTH hops:
//   - Chained dangling symlinks (e.g. apps/danger -> apps/mid -> <outside>,
//     where NEITHER leg exists on disk yet), INCLUDING a non-final hop
//     reached only after bestEffortReal rebuilds a missing intermediate
//     segment (e.g. apps/danger -> "mid/tail" where "mid" is itself the
//     dangling link) — the case bestEffortReal's parent-symlink check
//     exists specifically to catch, since this function alone only ever
//     re-lstats its OWN final result, not segments reattached inside
//     bestEffortReal's recursion.
//   - Lexical `..` collapse through an outward-pointing symlink, dangling
//     OR existing (e.g. apps/mid -> <outside> (dangling) with apps/danger
//     -> "mid/../pwned", or apps/hop3 -> <outside>/deep (exists) with
//     apps/danger3 -> "hop3/../newdir"): `raw` is concatenated onto `base`
//     WITHOUT going through path.resolve() (or path.join(), which
//     collapses `..` the same lexical way — see safeAppDir's ENOENT-branch
//     comment) first. Either would collapse the embedded `..` ahead of any
//     symlink check and land back inside APPS_DIR even though the kernel —
//     which applies `..` only AFTER following the symlink ahead of it —
//     lands outside. Keeping `..` as a literal path segment and letting
//     bestEffortReal's realpath()/parent-symlink handling do the resolving
//     applies it in that same, correct order.
// Caveats that remain OUT of scope, still not closed by this: a
// manufactured chain longer than MAX_SYMLINK_DEPTH falls back to the
// tolerant accept posture (same as a kernel ELOOP) rather than being
// rejected outright; the TOCTOU window between this check and a later
// write (the filesystem can change in between); and a symlink that
// resolves to APPS_DIR itself.
async function resolveSymlinkChain(base: string, raw: string, depth = 0): Promise<string> {
  if (depth >= MAX_SYMLINK_DEPTH) {
    const err = new Error("Too many levels of symbolic links") as NodeJS.ErrnoException;
    err.code = "ELOOP";
    throw err;
  }
  const targetPath = isAbsolute(raw) ? raw : base + sep + raw;
  const real = await bestEffortReal(targetPath, depth);
  // A non-ENOENT lstat error here (EACCES, EIO, a dirent racing away, ...)
  // is deliberately swallowed as "not a symlink": it stops the chain at the
  // current candidate and returns it as-is rather than propagating an
  // internal errno, matching this module's existing tolerant posture for
  // unresolvable link classes (see safeAppDir's own non-ENOENT branch).
  const link = await lstat(real).catch(() => null);
  if (!link?.isSymbolicLink()) return real;
  const nextTarget = await readlink(real);
  return resolveSymlinkChain(dirname(real), nextTarget, depth + 1);
}

const APP_NAME = /^[a-zA-Z0-9_-]+$/;
const COMMIT_REF = /^[a-fA-F0-9]{4,40}$|^HEAD~\d{1,3}$/;
const SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;
const BRANCH_NAME = /^[a-zA-Z0-9._/-]+$/;
const MAX_LOG_LINES = 1000;

export async function safeAppDir(name: string): Promise<string> {
  if (!APP_NAME.test(name)) throw new RelayConfigError("Invalid app name");
  const appsRoot = resolve(env.APPS_DIR);
  const dir = resolve(appsRoot, name);
  // `startsWith(appsRoot + sep)` (not just `appsRoot`) prevents a sibling-name
  // prefix false-positive: without the trailing separator `appsRoot = /apps`
  // would accept `/appsteak/...` as contained. Mirrors assertComposeFileContained.
  if (dir !== appsRoot && !dir.startsWith(appsRoot + sep)) {
    throw new RelayConfigError("Invalid app path");
  }
  // Resolve APPS_DIR's real path FIRST, then rebuild the app dir from that
  // resolved root before resolving symlinks on the app dir itself — both
  // sides of the containment check below must go through the same
  // normalization. Building the child from the unresolved `appsRoot` (via
  // `dir` above) and only falling back to that unresolved string when
  // `realpath(dir)` fails (ENOENT — the app doesn't exist yet, e.g. an app
  // never deployed) compares an unresolved child against a resolved parent.
  // That's a false positive whenever APPS_DIR's own path crosses a symlink
  // (e.g. /tmp -> /private/tmp or /var -> /private/var): the nonexistent
  // child keeps the symlinked prefix while the parent loses it, so a
  // genuinely-contained app dir looks like it escapes. Deriving the
  // fallback from `appsReal` keeps both sides in the same normalized form
  // while still resolving (and rejecting) a symlink escape inside the app
  // dir itself. The same trailing-separator guard applies after realpath,
  // so a symlink to a sibling-prefixed directory (e.g. /apps/x -> /appsteak)
  // cannot escape.
  const appsReal = await realpath(appsRoot).catch(() => appsRoot);
  const realBase = resolve(appsReal, name);
  const real = await realpath(realBase).catch(async (err: NodeJS.ErrnoException) => {
    // Only ENOENT gets the dangling-symlink treatment below. Every other
    // error class (ELOOP, ENOTDIR, EACCES, ...) keeps the pre-existing
    // tolerant fallback to the in-dir child path, same posture as
    // listApps' deliberate ELOOP tolerance: this check stays scoped to
    // the dangling-link case, and the kernel cannot follow what it
    // cannot resolve, so nothing new escapes through that fallback.
    if (err.code !== "ENOENT") return realBase;
    // realpath() throws ENOENT both when `realBase` simply doesn't exist yet
    // (a never-deployed app: fall back to the unresolved path, handled
    // below) and when it exists as a DANGLING top-level symlink whose
    // target doesn't exist yet — e.g. APPS_DIR/<name> -> /etc, planted
    // before the target path is created. realpath can't resolve a target
    // that doesn't exist, so it ENOENTs in both cases; lstat (which does
    // NOT follow symlinks) tells them apart. For the symlink case we
    // resolve the link target ourselves via resolveSymlinkChain() — the
    // same normalization realpath would apply once the target exists,
    // generalized to follow a CHAIN of dangling symlinks segment by
    // segment in kernel order, up to MAX_SYMLINK_DEPTH hops (not just the
    // immediate one, and including a dangling symlink reattached mid-chain
    // by bestEffortReal, not only a chain's own final leg) and to apply an
    // embedded `..` in kernel order rather than lexically (see
    // resolveSymlinkChain's own comment for exactly which variants this
    // closes and which caveats remain) — and reject it here if that
    // target escapes APPS_DIR, instead of silently falling back to the
    // in-dir child path and letting a later write follow the link out.
    const link = await lstat(realBase).catch(() => null);
    if (link?.isSymbolicLink()) {
      try {
        const target = await readlink(realBase);
        const resolvedTarget = await resolveSymlinkChain(dirname(realBase), target);
        if (resolvedTarget !== appsReal && !resolvedTarget.startsWith(appsReal + sep)) {
          throw new RelayConfigError("App path escapes APPS_DIR");
        }
      } catch (linkErr) {
        if (linkErr instanceof RelayConfigError) throw linkErr;
        // Same posture as the non-ENOENT branch above: an unresolvable
        // link target (ELOOP chain — including a manufactured chain
        // exceeding MAX_SYMLINK_DEPTH — EACCES, a dirent racing away)
        // falls back to the pre-existing in-dir child path instead of
        // leaking a raw errno out of the API as a 500.
        return realBase;
      }
    }
    return realBase;
  });
  if (real !== appsReal && !real.startsWith(appsReal + sep)) {
    throw new RelayConfigError("App path escapes APPS_DIR");
  }
  return real;
}

export function validateCommitRef(ref: string): string {
  if (!COMMIT_REF.test(ref)) throw new Error("Invalid commit reference");
  return ref;
}

export function validateServiceName(name: string): string {
  if (!SERVICE_NAME.test(name)) throw new Error("Invalid service name");
  return name;
}

export function validateBranch(branch: string): string {
  if (!BRANCH_NAME.test(branch)) throw new Error("Invalid branch name");
  return branch;
}

export function clampLogLines(lines?: number): number {
  return Math.min(lines ?? 50, MAX_LOG_LINES);
}

export async function listApps(): Promise<Array<{ name: string; configured: boolean; health?: string; commit?: string }>> {
  try {
    const entries = await readdir(env.APPS_DIR, { withFileTypes: true });
    // Follow symlinks: isDirectory() returns false for symlinks, so stat() to resolve
    const names = await Promise.all(
      entries.map(async (e) => {
        if (e.isDirectory()) return e.name;
        if (e.isSymbolicLink()) {
          const s = await stat(resolve(env.APPS_DIR, e.name)).catch((err: NodeJS.ErrnoException) => {
            if (err.code === "ENOENT" || err.code === "ELOOP") return null;
            throw err;
          });
          if (s?.isDirectory()) return e.name;
        }
        return null;
      }),
    );
    const dirs = names.filter((n): n is string => n !== null);

    return Promise.all(dirs.map(async (name) => {
      const dir = resolve(env.APPS_DIR, name);
      try {
        const config = await loadRelayConfig(dir);
        const commit = await runExec("git", ["rev-parse", "--short", "HEAD"], dir);
        return { name, configured: true, health: config.health, commit: commit.stdout.trim() || "unknown" };
      } catch {
        return { name, configured: false };
      }
    }));
  } catch {
    return [];
  }
}

export async function getAppDetail(name: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const commit = await runExec("git", ["rev-parse", "--short", "HEAD"], dir);
  const ps = await runExec("docker", ["compose", "-f", config.compose_file, "ps", "--format", "json"], dir);

  return {
    name,
    config,
    commit: commit.stdout.trim(),
    containers: ps.exitCode === 0 ? ps.stdout.trim() : null,
  };
}

export async function deployApp(name: string, options?: { branch?: string; force?: boolean }) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const branch = options?.branch ? validateBranch(options.branch) : undefined;
  return deploy({ appDir: dir, config, branch, force: options?.force });
}

export async function deployAppStreaming(
  name: string,
  options?: { branch?: string; force?: boolean },
  onStep?: (step: import("../deploy/engine.js").DeployStep) => void,
) {
  const dir = await safeAppDir(name);
  // Pre-pull config: the engine re-loads .relay.yml after `git pull`
  // so build/up/post_update/health/preflight see the post-pull config.
  const config = await loadRelayConfig(dir);
  const branch = options?.branch ? validateBranch(options.branch) : undefined;
  return deploy({
    appDir: dir,
    config,
    branch,
    force: options?.force,
    onStep,
  });
}

/**
 * Returned when preflight rejects the standalone rollback. Mirrors
 * deploy/engine.ts's `DeployBlockedResult` shape (`blocked: true` +
 * `preflight`) so the HTTP and MCP surfaces can branch on the same `"blocked"
 * in result` check they already use for a blocked deploy, instead of
 * throwing a flat Error message that would read identically to any other
 * rollback failure (bad commit ref, docker build failure, ...). The working
 * tree has already been reset to `target` by the time this can be returned
 * (see rollbackApp below), so `commitAfter` reflects that — the rollback is
 * blocked, not silently a no-op.
 */
export interface RollbackBlockedResult {
  success: false;
  blocked: true;
  preflight: PreflightReport;
  commitBefore: string;
  commitAfter: string;
}

export interface RollbackResult {
  success: true;
  commitBefore: string;
  commitAfter: string;
}

export async function rollbackApp(
  name: string,
  toCommit?: string,
): Promise<RollbackResult | RollbackBlockedResult> {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const target = toCommit ? validateCommitRef(toCommit) : "HEAD~1";

  const commitBefore = (await runExec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();

  const checkout = await runExec("git", ["reset", "--hard", target], dir);
  if (checkout.exitCode !== 0) throw new Error("Rollback failed: " + checkout.stderr);

  // Same gate, same rationale, as deploy/engine.ts's rollbackIfEnabled: the
  // 2026-07-15 incident class (docker silently auto-creating an empty
  // bind-mount directory over a deployed app's config) applies just as much
  // to this standalone rollback path as it does to auto-rollback or a
  // forward deploy. `phase: "all"` covers both `apps_root_mount_congruence`
  // and `compose_bind_mount_sources_exist`; `force: true` means only the
  // critical checks gate — `git_clean`/`git_remote_reachable` are about
  // protecting a `git pull`, which this function never runs (it resets
  // hard), so gating on them here would fail rollbacks for reasons that
  // don't apply to rollback at all.
  const preflight = await runPreflightChecks({ appDir: dir, config, phase: "all", force: true });
  if (!preflight.passed) {
    const commitAfter = (await runExec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
    return { success: false, blocked: true, preflight, commitBefore, commitAfter };
  }

  const build = await runExec("docker", ["compose", "-f", config.compose_file, "build"], dir);
  if (build.exitCode !== 0) throw new Error("Rebuild failed: " + build.stderr);

  const up = await runExec("docker", ["compose", "-f", config.compose_file, "up", "-d"], dir);
  if (up.exitCode !== 0) throw new Error("Restart failed: " + up.stderr);

  const commitAfter = (await runExec("git", ["rev-parse", "HEAD"], dir)).stdout.trim();
  return { success: true, commitBefore, commitAfter };
}

export async function fetchLogs(name: string, lines?: number, service?: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  const n = clampLogLines(lines);
  const svc = service ? validateServiceName(service) : "";

  const result = await runExec(
    "docker",
    ["compose", "-f", config.compose_file, "logs", `--tail=${n}`, "--no-color", ...(svc ? [svc] : [])],
    dir,
  );

  if (result.exitCode !== 0) throw new Error("Failed to get logs: " + result.stderr);
  return { app: name, lines: n, logs: result.stdout };
}

export async function runPreflight(name: string) {
  const dir = await safeAppDir(name);
  const config = await loadRelayConfig(dir);
  return runPreflightChecks({ appDir: dir, config });
}
