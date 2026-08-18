import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { safeAppDir, validateBranch, fetchLogs, rollbackApp } from "./apps.js";
import { env } from "../config/env.js";
import type { RelayConfig } from "../config/relay.js";

// Mock exec and relay so fetchLogs tests don't require a real docker + compose file on disk.
vi.mock("../deploy/exec.js", () => ({
  runExec: vi.fn(),
  runShell: vi.fn(),
}));

vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return { ...actual, loadRelayConfig: vi.fn() };
});

// Mock preflight for rollbackApp's gating tests below — mirrors the pattern
// in deploy/engine.test.ts (mock the module, keep everything except
// runPreflightChecks real).
vi.mock("../deploy/preflight.js", async () => {
  const actual = await vi.importActual<typeof import("../deploy/preflight.js")>(
    "../deploy/preflight.js",
  );
  return { ...actual, runPreflightChecks: vi.fn() };
});

import { runExec } from "../deploy/exec.js";
import { loadRelayConfig } from "../config/relay.js";
import { runPreflightChecks } from "../deploy/preflight.js";

const mockRunExec = vi.mocked(runExec);
const mockLoadRelayConfig = vi.mocked(loadRelayConfig);
const mockRunPreflightChecks = vi.mocked(runPreflightChecks);

describe("validateBranch", () => {
  it("accepts well-formed branch names", () => {
    expect(validateBranch("main")).toBe("main");
    expect(validateBranch("feat/x")).toBe("feat/x");
    expect(validateBranch("release/v1.0.0")).toBe("release/v1.0.0");
    expect(validateBranch("fix/a-b_c.d")).toBe("fix/a-b_c.d");
  });

  it("rejects branch names carrying shell metacharacters", () => {
    expect(() => validateBranch("main';rm -rf /")).toThrow("Invalid branch name");
    expect(() => validateBranch("feature branch")).toThrow("Invalid branch name");
    expect(() => validateBranch("main|cat /etc/passwd")).toThrow("Invalid branch name");
    expect(() => validateBranch("main$(whoami)")).toThrow("Invalid branch name");
    expect(() => validateBranch("main`id`")).toThrow("Invalid branch name");
    expect(() => validateBranch("main\nrm -rf /")).toThrow("Invalid branch name");
  });
});

describe("safeAppDir", () => {
  let tmpRoot: string;
  let appsDir: string;
  let originalAppsDir: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-safeappdir-"));
    appsDir = resolve(tmpRoot, "apps");
    await mkdir(appsDir, { recursive: true });
    originalAppsDir = env.APPS_DIR;
    env.APPS_DIR = appsDir;
  });

  afterEach(async () => {
    env.APPS_DIR = originalAppsDir;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("rejects an invalid app name", async () => {
    await expect(safeAppDir("../evil")).rejects.toThrow("Invalid app name");
  });

  it("resolves a legitimate app directory to its real path", async () => {
    const appDir = resolve(appsDir, "demo");
    await mkdir(appDir);
    const expected = await realpath(appDir);
    await expect(safeAppDir("demo")).resolves.toBe(expected);
  });

  it("resolves a not-yet-existing app dir under a symlinked APPS_DIR parent", async () => {
    // Regression for the /var -> /private/var class: APPS_DIR itself crosses
    // a symlink and the app dir does not exist yet. Building the ENOENT
    // fallback from the unresolved parent compared a symlinked child prefix
    // against the resolved root and false-positived as an escape. Kept
    // host-independent via an explicit symlink so the guard also fails on
    // CI runners whose tmpdir is a real directory.
    const linkRoot = resolve(tmpRoot, "apps-link");
    await symlink(appsDir, linkRoot);
    env.APPS_DIR = linkRoot;
    const expected = resolve(await realpath(appsDir), "neverdeployed");
    await expect(safeAppDir("neverdeployed")).resolves.toBe(expected);
  });

  it("rejects a symlink escaping to a sibling-prefixed dir (apps vs apps-evil)", async () => {
    // The trailing-separator false-positive: a symlink APPS_DIR/escape ->
    // <tmpRoot>/apps-evil. Its realpath string-starts with appsReal
    // (<tmpRoot>/apps) yet is NOT contained. Without the `+ sep` guard the
    // old check accepted it.
    const sibling = resolve(tmpRoot, "apps-evil");
    await mkdir(sibling, { recursive: true });
    await symlink(sibling, resolve(appsDir, "escape"));
    await expect(safeAppDir("escape")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects a DANGLING top-level symlink whose target is outside APPS_DIR", async () => {
    // Defense-in-depth follow-up to PR #64: a symlink APPS_DIR/danger ->
    // <tmpRoot>/not-created-yet is planted before its target exists.
    // realpath(child) ENOENTs (the target doesn't exist), and the old
    // fallback treated that ENOENT as "app not deployed yet" and returned
    // the in-dir child path unconditionally — even though the entry IS a
    // symlink pointing outside APPS_DIR. A later write following that link
    // would land outside APPS_DIR the moment the target is created.
    const outsideTarget = resolve(tmpRoot, "not-created-yet");
    await symlink(outsideTarget, resolve(appsDir, "danger"));
    await expect(safeAppDir("danger")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects a DANGLING top-level symlink with a relative target outside APPS_DIR", async () => {
    // Same as above but with a relative symlink target (e.g. `../../etc`),
    // which resolves against the symlink's own directory rather than cwd.
    await symlink("../not-created-yet", resolve(appsDir, "danger-relative"));
    await expect(safeAppDir("danger-relative")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("still resolves a not-yet-existing app dir that is NOT a symlink (no dirent at all)", async () => {
    // Pins the PR #64 fallback: safeAppDir("neverdeployed") in the earlier
    // test above already covers this for a symlinked APPS_DIR parent; this
    // covers the plain case where APPS_DIR/<name> has no dirent whatsoever
    // (neither a real dir nor a symlink), which must still fall back to the
    // in-dir child path rather than being rejected.
    const expected = resolve(await realpath(appsDir), "stillnodir");
    await expect(safeAppDir("stillnodir")).resolves.toBe(expected);
  });

  it("does not reject a dangling top-level symlink whose target stays inside APPS_DIR", async () => {
    // A symlink pointing at a not-yet-created sibling dir *inside*
    // APPS_DIR is not an escape and must still resolve — to the symlink's
    // own (resolved-parent) location, same contract as the plain
    // never-deployed fallback above, not to its (nonexistent) target.
    const linkPath = resolve(appsDir, "future-app");
    const insideTarget = resolve(appsDir, "not-yet-created-sibling");
    await symlink(insideTarget, linkPath);
    const expected = resolve(await realpath(appsDir), "future-app");
    await expect(safeAppDir("future-app")).resolves.toBe(expected);
  });

  it("does not reject a dangling top-level symlink under a symlinked APPS_DIR whose absolute target stays inside APPS_DIR", async () => {
    // Host-independent regression for the /var -> /private/var class,
    // applied to the new target-containment check itself (mirrors the
    // symlinked-APPS_DIR-parent test above, but for a dangling symlink's
    // OWN target rather than the app dir itself). env.APPS_DIR is set to
    // `linkRoot`, an explicit symlink to `appsDir`, so this forces the same
    // symlink-crossing on every host, not just ones where the OS tmpdir
    // happens to cross one (e.g. macOS /var -> /private/var). The dangling
    // symlink's absolute target is built from that unresolved `linkRoot`
    // prefix, as a real deploy naturally would; a naive lexical resolve()
    // of the target would keep that unresolved prefix and never match
    // `appsReal`, false-positiving a legitimately-contained target as an
    // escape. bestEffortReal() must resolve it through the same symlinked
    // ancestor as `appsReal` before comparing.
    const linkRoot = resolve(tmpRoot, "apps-link-2");
    await symlink(appsDir, linkRoot);
    env.APPS_DIR = linkRoot;
    const insideTargetUnresolved = resolve(linkRoot, "not-yet-created-sibling");
    await symlink(insideTargetUnresolved, resolve(linkRoot, "future-app-2"));
    const expected = resolve(await realpath(appsDir), "future-app-2");
    await expect(safeAppDir("future-app-2")).resolves.toBe(expected);
  });

  it("keeps the tolerant fallback for a self-referential symlink (ELOOP)", async () => {
    // Error-class pin: only ENOENT gets the dangling-symlink treatment.
    // A symlink loop makes realpath() throw ELOOP; the pre-#64 behavior
    // (and listApps' deliberate posture) is the tolerant in-dir fallback,
    // not a raw errno leaking out of the API as a 500. The kernel cannot
    // follow a loop either, so nothing escapes through this fallback.
    const loopPath = resolve(appsDir, "loop");
    await symlink(loopPath, loopPath);
    const expected = resolve(await realpath(appsDir), "loop");
    await expect(safeAppDir("loop")).resolves.toBe(expected);
  });

  it("keeps the tolerant fallback for a symlink through a regular file (ENOTDIR)", async () => {
    // Same error-class pin for ENOTDIR: a symlink whose target path
    // descends through an existing regular file must fall back to the
    // in-dir child path, not throw a raw errno.
    await writeFile(resolve(appsDir, "afile"), "not a dir\n");
    await symlink(resolve(appsDir, "afile", "sub"), resolve(appsDir, "through-file"));
    const expected = resolve(await realpath(appsDir), "through-file");
    await expect(safeAppDir("through-file")).resolves.toBe(expected);
  });

  it("rejects chained dangling symlinks with an absolute first jump (B1)", async () => {
    // Follow-up to PR #68 (task d39b85ce): bestEffortReal() only resolved
    // the IMMEDIATE readlink target. If that target was ITSELF a dangling
    // symlink, the old code walked up to the nearest existing ancestor
    // (APPS_DIR) and rebuilt the tail lexically, accepting the chain as
    // contained even though the kernel would follow it outside APPS_DIR.
    // apps/hop -> <tmpRoot>/outside-b1 (dangling, absolute, outside
    // APPS_DIR), then apps/danger -> apps/hop.
    const outside = resolve(tmpRoot, "outside-b1");
    await symlink(outside, resolve(appsDir, "hop"));
    await symlink(resolve(appsDir, "hop"), resolve(appsDir, "danger"));
    await expect(safeAppDir("danger")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects chained dangling symlinks with a relative first jump (B2)", async () => {
    // Same class as B1 (task d39b85ce), with a relative first jump:
    // apps/hop2 -> "../outside-b2" (dangling, relative, outside APPS_DIR),
    // then apps/danger2 -> "hop2" (relative).
    await symlink("../outside-b2", resolve(appsDir, "hop2"));
    await symlink("hop2", resolve(appsDir, "danger2"));
    await expect(safeAppDir("danger2")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects a lexical `..` collapse through an existing outward symlink (B3)", async () => {
    // Follow-up to PR #68 (task d39b85ce): the old code built the link
    // target path with `resolve(dirname(realBase), target)`, which
    // collapses `..` TEXTUALLY before any filesystem access, while the
    // kernel resolves `..` only AFTER following the symlink ahead of it.
    // apps/hop3 -> <tmpRoot>/outside-b3/deep (EXISTS), apps/danger3 ->
    // "hop3/../newdir" (the "newdir" tail does not exist). Lexically this
    // collapses to <apps>/newdir (looks contained); the kernel really
    // lands on <tmpRoot>/outside-b3/newdir (outside APPS_DIR).
    const outside = resolve(tmpRoot, "outside-b3");
    const deep = resolve(outside, "deep");
    await mkdir(deep, { recursive: true });
    await symlink(deep, resolve(appsDir, "hop3"));
    await symlink("hop3/../newdir", resolve(appsDir, "danger3"));
    await expect(safeAppDir("danger3")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects a dangling intermediate segment reattached mid-chain, absolute target (P1)", async () => {
    // Fix-round follow-up to task d39b85ce (round 1 review): bestEffortReal
    // rebuilds a MISSING segment lexically via resolve(realParent,
    // basename) but, before this fix, never re-checked whether that
    // rebuilt segment was itself a symlink — so a dangling link reattached
    // mid-chain (not just the chain's own final leg) was never followed.
    // apps/mid -> <tmpRoot>/outside-p1 (dangling, absolute), apps/danger ->
    // "mid/tail" (relative, tail appended past the dangling hop). Kernel
    // truth: <tmpRoot>/outside-p1/tail, outside APPS_DIR. Measured
    // ACCEPTED before this round's fix; must be rejected now.
    const outside = resolve(tmpRoot, "outside-p1");
    await symlink(outside, resolve(appsDir, "mid"));
    await symlink("mid/tail", resolve(appsDir, "danger"));
    await expect(safeAppDir("danger")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects `..` collapsing through a DANGLING outward symlink (P2)", async () => {
    // Same root cause as P1, exercised through the `..`-collapse path
    // instead of a plain tail: apps/mid -> <tmpRoot>/outside-p2/sub
    // (dangling, absolute), apps/danger -> "mid/../pwned". The B3 test
    // above only covers `..` after an EXISTING outward symlink; this pins
    // the dangling variant of the same escape. Kernel truth:
    // <tmpRoot>/outside-p2/pwned (".." cancels "sub", landing outside
    // APPS_DIR). Measured ACCEPTED before this round's fix.
    const outside = resolve(tmpRoot, "outside-p2", "sub");
    await symlink(outside, resolve(appsDir, "mid"));
    await symlink("mid/../pwned", resolve(appsDir, "danger"));
    await expect(safeAppDir("danger")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("rejects a dangling intermediate segment reattached mid-chain, deeper tail (P12)", async () => {
    // Same class as P1 with a two-segment tail, pinning that the fix
    // applies uniformly regardless of how many segments are rebuilt after
    // the dangling hop. apps/mid -> <tmpRoot>/outside-p12 (dangling),
    // apps/danger -> "mid/a/b". Kernel truth: <tmpRoot>/outside-p12/a/b.
    const outside = resolve(tmpRoot, "outside-p12");
    await symlink(outside, resolve(appsDir, "mid"));
    await symlink("mid/a/b", resolve(appsDir, "danger"));
    await expect(safeAppDir("danger")).rejects.toThrow("App path escapes APPS_DIR");
  });

  it("does not reject a chain of in-dir dangling symlinks under a symlinked APPS_DIR (no over-reject)", async () => {
    // Positive control for the P1/P2/P12 fix: the same mid-chain
    // parent-symlink re-check must NOT reject a chain that stays fully
    // contained. apps/chainA -> "chainB" -> "chainC" (all relative,
    // in-dir; chainC itself is never created, so the whole chain stays
    // dangling), resolved under a symlinked APPS_DIR parent (env.APPS_DIR
    // = linkRoot) to also exercise the appsReal-crossing path.
    const linkRoot = resolve(tmpRoot, "apps-link-3");
    await symlink(appsDir, linkRoot);
    env.APPS_DIR = linkRoot;
    await symlink("chainB", resolve(appsDir, "chainA"));
    await symlink("chainC", resolve(appsDir, "chainB"));
    const expected = resolve(await realpath(appsDir), "chainA");
    await expect(safeAppDir("chainA")).resolves.toBe(expected);
  });

  it("terminates on a cyclic, kernel-invisible manufactured symlink chain (depth-limit pin)", async () => {
    // Fix-round follow-up (finding 3): the old CHAIN_LENGTH=50 version of
    // this test was inert — measured against both origin/main AND this
    // branch with MAX_SYMLINK_DEPTH deleted entirely, it passed unchanged
    // either way. A fully-materialized 50-symlink chain trips the KERNEL's
    // own ELOOP inside realpath() before this module's own depth guard is
    // ever reached, so the assertion (in a try/catch that only fires on a
    // RangeError) never actually exercised MAX_SYMLINK_DEPTH.
    // This construction is kernel-invisible instead: apps/a -> "nodir/../b"
    // and apps/b -> "nodir/../a". "nodir" never exists, so every hop
    // resolves through this module's OWN bestEffortReal/resolveSymlinkChain
    // recursion (never a single kernel-followed symlink chain the OS could
    // ELOOP on its own) and cycles a<->b indefinitely without our own
    // MAX_SYMLINK_DEPTH guard. The assertion below is unconditional
    // (outside any catch): without the guard this hangs (measured: still
    // unresolved after 3s in a bounded mutation probe, vs. ~2-10ms with the
    // guard in place); with the guard, the ELOOP it raises is caught by
    // safeAppDir's existing tolerant ELOOP-class fallback and the promise
    // resolves.
    await symlink("nodir/../b", resolve(appsDir, "a"));
    await symlink("nodir/../a", resolve(appsDir, "b"));
    await expect(safeAppDir("a")).resolves.toBeDefined();
  });

  it("rejects a ~30-hop manufactured chain ending outside APPS_DIR (under kernel SYMLOOP)", async () => {
    // Companion to the cyclic test above: exercises this module's OWN
    // per-hop depth counting (not the kernel's) on a chain short enough
    // that the kernel's own SYMLOOP_MAX (~32-40, OS-dependent) does not
    // intervene, so a failure here is attributable to OUR recursion, not a
    // kernel-level ELOOP. apps/link0 -> link1 -> ... -> link30 -> <outside>
    // (dangling, absolute, outside APPS_DIR). Must be rejected as an
    // escape, not silently accepted or ELOOP-tolerated.
    const CHAIN_LENGTH = 30;
    for (let i = 0; i < CHAIN_LENGTH; i++) {
      await symlink(`link${i + 1}`, resolve(appsDir, `link${i}`));
    }
    await symlink(resolve(tmpRoot, "outside-30hop"), resolve(appsDir, `link${CHAIN_LENGTH}`));
    await expect(safeAppDir("link0")).rejects.toThrow("App path escapes APPS_DIR");
  });
});

// Coverage for fetchLogs migrated call sites: compose_file is the element
// immediately after the -f flag in the runExec arg array, never shell-interpolated.
describe("fetchLogs — compose_file passed as literal arg-array element", () => {
  let tmpRoot: string;
  let appsDir: string;
  let originalAppsDir: string;

  const fakeConfig: RelayConfig = {
    name: "myapp",
    health: "/health",
    compose_file: "docker-compose.prod.yml",
    pre_update: [],
    post_update: [],
    rollback: true,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-fetchlogs-"));
    appsDir = resolve(tmpRoot, "apps");
    await mkdir(resolve(appsDir, "myapp"), { recursive: true });
    originalAppsDir = env.APPS_DIR;
    env.APPS_DIR = appsDir;
    mockLoadRelayConfig.mockResolvedValue(fakeConfig);
    mockRunExec.mockResolvedValue({ stdout: "log line 1\nlog line 2", stderr: "", exitCode: 0 });
  });

  afterEach(async () => {
    env.APPS_DIR = originalAppsDir;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("passes compose_file as the element after -f when no service is given", async () => {
    await fetchLogs("myapp");
    expect(mockRunExec).toHaveBeenCalledOnce();
    const [, args] = mockRunExec.mock.calls[0]!;
    const dashFIdx = args.indexOf("-f");
    expect(dashFIdx).toBeGreaterThanOrEqual(0);
    expect(args[dashFIdx + 1]).toBe("docker-compose.prod.yml");
    // No service appended — last arg is --no-color
    expect(args.at(-1)).toBe("--no-color");
  });

  it("passes compose_file as the element after -f and appends the service name", async () => {
    await fetchLogs("myapp", undefined, "backend");
    expect(mockRunExec).toHaveBeenCalledOnce();
    const [, args] = mockRunExec.mock.calls[0]!;
    const dashFIdx = args.indexOf("-f");
    expect(dashFIdx).toBeGreaterThanOrEqual(0);
    expect(args[dashFIdx + 1]).toBe("docker-compose.prod.yml");
    // Service name is the final element when provided
    expect(args.at(-1)).toBe("backend");
  });
});

// Task 1074feb5: rollbackApp used to run `git reset --hard` then `docker
// compose build`/`up` with no preflight gating at all, reintroducing the
// bind-mount-empty-dir incident class (2026-07-15) that d5e0aad9 closed for
// forward deploys. These tests pin that the standalone rollback path is now
// gated the same critical checks, before compose build/up, and that a
// blocked rollback returns a structured result (mirroring
// DeployBlockedResult) instead of silently proceeding.
describe("rollbackApp — preflight gate", () => {
  let tmpRoot: string;
  let appsDir: string;
  let originalAppsDir: string;

  const fakeConfig: RelayConfig = {
    name: "myapp",
    health: "/health",
    compose_file: "docker-compose.yml",
    pre_update: [],
    post_update: [],
    rollback: true,
  };

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await mkdtemp(resolve(tmpdir(), "agent-relay-rollbackapp-"));
    appsDir = resolve(tmpRoot, "apps");
    await mkdir(resolve(appsDir, "myapp"), { recursive: true });
    originalAppsDir = env.APPS_DIR;
    env.APPS_DIR = appsDir;
    mockLoadRelayConfig.mockResolvedValue(fakeConfig);
    mockRunExec.mockResolvedValue({ stdout: "abc123\n", stderr: "", exitCode: 0 });
  });

  afterEach(async () => {
    env.APPS_DIR = originalAppsDir;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("blocks rollback and returns a structured blocked result when a critical check fails (missing bind-mount source)", async () => {
    mockRunPreflightChecks.mockResolvedValue({
      passed: false,
      checks: [
        {
          name: "compose_bind_mount_sources_exist",
          passed: false,
          message: "Missing compose bind-mount source path(s) referenced in docker-compose.yml",
          critical: true,
        },
      ],
    });

    const result = await rollbackApp("myapp", "HEAD~1");

    expect(result.success).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
    if ("blocked" in result) {
      expect(result.preflight.passed).toBe(false);
      expect(result.preflight.checks[0]?.name).toBe("compose_bind_mount_sources_exist");
      expect(result.commitBefore).toBe("abc123");
      // The working tree WAS reset (checkout succeeded) even though the
      // rollback is blocked before compose build/up — commitAfter reflects
      // that, distinguishing "blocked" from "no-op".
      expect(result.commitAfter).toBe("abc123");
    }
    // compose build/up must never have run.
    const buildCall = mockRunExec.mock.calls.find(([cmd, args]) => cmd === "docker" && args.includes("build"));
    expect(buildCall).toBeUndefined();
    const upCall = mockRunExec.mock.calls.find(([cmd, args]) => cmd === "docker" && args.includes("up"));
    expect(upCall).toBeUndefined();
  });

  it("proceeds through compose build/up and returns success when preflight passes", async () => {
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });

    const result = await rollbackApp("myapp");

    expect(result.success).toBe(true);
    expect("blocked" in result).toBe(false);
    const buildCall = mockRunExec.mock.calls.find(([cmd, args]) => cmd === "docker" && args.includes("build"));
    expect(buildCall).toBeDefined();
    const upCall = mockRunExec.mock.calls.find(([cmd, args]) => cmd === "docker" && args.includes("up"));
    expect(upCall).toBeDefined();
  });

  it("runs preflight with phase: 'all', force: true, only: the two critical rollback checks against the app dir before gating", async () => {
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });

    await rollbackApp("myapp");

    expect(mockRunPreflightChecks).toHaveBeenCalledOnce();
    const callArgs = mockRunPreflightChecks.mock.calls[0]![0];
    expect(callArgs.phase).toBe("all");
    expect(callArgs.force).toBe(true);
    expect(callArgs.config).toEqual(fakeConfig);
    // MED-3: the rollback gate must restrict the battery to exactly the two
    // checks that catch the DooD host/relay APPS_DIR mismatch — the other 6
    // (git-pull-only or non-critical signal) must never even be requested,
    // since an emergency rollback shouldn't wait on runExec calls (300s
    // timeout each) that buy it nothing. Negative control: deleting `only`
    // from the rollbackApp call site turns this assertion red (measured
    // below in the fix-round mutation probe).
    expect(callArgs.only).toEqual([
      "apps_root_mount_congruence",
      "compose_bind_mount_sources_exist",
    ]);
  });

  // MED-2 fix-round regression: reviewer mutation M9 moved the preflight
  // block to BEFORE `git reset --hard` in rollbackApp. Every existing test
  // above still passed 231/231 against that mutant, because none of them
  // pin the *order* of the two calls — only that both happen and that a
  // blocked preflight prevents compose build/up. Placement AFTER the reset
  // is the entire point of this gate (see the RollbackBlockedResult JSDoc:
  // "the working tree has already been reset to `target` by the time this
  // can be returned"): the reviewer's mutant reset the tree AFTER preflight
  // already ran, without re-checking. This test pins that ordering directly
  // via mock.invocationCallOrder (a global counter vitest assigns across
  // ALL mock functions in the test, not just the one it's called on), so a
  // reordering trips it even though every other assertion in this file
  // stays green.
  it("orders the preflight call AFTER the git reset --hard runExec call, not before (M9 regression)", async () => {
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });

    await rollbackApp("myapp");

    const resetCallIndex = mockRunExec.mock.calls.findIndex(
      ([cmd, args]) => cmd === "git" && args.includes("reset") && args.includes("--hard"),
    );
    expect(resetCallIndex).toBeGreaterThanOrEqual(0);
    const resetOrder = mockRunExec.mock.invocationCallOrder[resetCallIndex]!;

    expect(mockRunPreflightChecks).toHaveBeenCalledOnce();
    const preflightOrder = mockRunPreflightChecks.mock.invocationCallOrder[0]!;

    expect(preflightOrder).toBeGreaterThan(resetOrder);
  });

  // LOW-6: rollbackApp used to load .relay.yml BEFORE the reset, so
  // preflight and compose build/up ran against whatever config was on disk
  // pre-rollback rather than the config the rolled-back commit actually
  // ships (analogous to why deploy/engine.ts re-reads .relay.yml after
  // `git pull`, see its "reload .relay.yml" step). This pins that
  // loadRelayConfig is called AFTER the git reset --hard call, so the
  // reloaded config — not a pre-reset snapshot — is what preflight/build/up
  // see.
  it("reloads .relay.yml AFTER the git reset --hard call, not before", async () => {
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });

    await rollbackApp("myapp");

    const resetCallIndex = mockRunExec.mock.calls.findIndex(
      ([cmd, args]) => cmd === "git" && args.includes("reset") && args.includes("--hard"),
    );
    expect(resetCallIndex).toBeGreaterThanOrEqual(0);
    const resetOrder = mockRunExec.mock.invocationCallOrder[resetCallIndex]!;

    expect(mockLoadRelayConfig).toHaveBeenCalledOnce();
    const loadOrder = mockLoadRelayConfig.mock.invocationCallOrder[0]!;

    expect(loadOrder).toBeGreaterThan(resetOrder);
  });
});
