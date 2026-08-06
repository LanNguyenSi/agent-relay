import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, rm, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { safeAppDir, validateBranch, fetchLogs } from "./apps.js";
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

import { runExec } from "../deploy/exec.js";
import { loadRelayConfig } from "../config/relay.js";

const mockRunExec = vi.mocked(runExec);
const mockLoadRelayConfig = vi.mocked(loadRelayConfig);

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
