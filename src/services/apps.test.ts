import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, symlink, rm, realpath } from "node:fs/promises";
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
