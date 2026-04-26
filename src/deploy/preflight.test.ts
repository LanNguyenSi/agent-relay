import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RelayConfig } from "../config/relay.js";

vi.mock("./exec.js", () => ({
  shell: vi.fn(),
  exec: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
}));

import { runPreflightChecks } from "./preflight.js";
import { shell, exec } from "./exec.js";
import { access, readFile } from "node:fs/promises";

const mockShell = vi.mocked(shell);
const mockExec = vi.mocked(exec);
const mockAccess = vi.mocked(access);
const mockReadFile = vi.mocked(readFile);

const baseConfig: RelayConfig = {
  name: "test-app",
  health: "/health",
  compose_file: "docker-compose.yml",
  pre_update: [],
  post_update: [],
  rollback: true,
};

beforeEach(() => {
  vi.resetAllMocks();

  // Defaults: everything passes
  mockAccess.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue("services:\n  app:\n    labels:\n      - traefik.enable=true\n" as any);
  mockExec.mockResolvedValue({ stdout: "abc123\n", stderr: "", exitCode: 0 });
  mockShell.mockImplementation(async (cmd) => {
    if (cmd.includes("git status")) {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    if (cmd.includes("git ls-remote")) {
      return { stdout: "ref\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

describe("runPreflightChecks", () => {
  it("passes when all checks succeed", async () => {
    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.checks.every((c) => c.passed)).toBe(true);
  });

  it("fails when compose file is missing", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT"));

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "compose_file_exists");
    expect(check?.passed).toBe(false);
    expect(check?.critical).toBe(true);
  });

  it("fails when no containers running", async () => {
    mockExec.mockResolvedValue({ stdout: "", stderr: "", exitCode: 0 });

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "containers_running");
    expect(check?.passed).toBe(false);
  });

  it("fails when traefik labels missing", async () => {
    mockReadFile.mockResolvedValue("services:\n  app:\n    image: node\n" as any);

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "traefik_labels");
    expect(check?.passed).toBe(false);
    expect(check?.critical).toBe(false);
  });

  it("fails when git has uncommitted changes", async () => {
    mockShell.mockImplementation(async (cmd) => {
      if (cmd.includes("docker compose")) return { stdout: "abc\n", stderr: "", exitCode: 0 };
      if (cmd.includes("git status")) return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
      if (cmd.includes("git ls-remote")) return { stdout: "ref", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "git_clean");
    expect(check?.passed).toBe(false);
  });

  it("fails when git remote unreachable", async () => {
    mockShell.mockImplementation(async (cmd) => {
      if (cmd.includes("docker compose")) return { stdout: "abc\n", stderr: "", exitCode: 0 };
      if (cmd.includes("git status")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("git ls-remote")) return { stdout: "", stderr: "fatal", exitCode: 128 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "git_remote_reachable");
    expect(check?.passed).toBe(false);
    expect(check?.critical).toBe(false);
  });

  it("force flag ignores non-critical failures", async () => {
    // Traefik labels missing (non-critical) + git dirty (non-critical)
    mockReadFile.mockResolvedValue("services:\n  app:\n    image: node\n" as any);
    mockShell.mockImplementation(async (cmd) => {
      if (cmd.includes("docker compose")) return { stdout: "abc\n", stderr: "", exitCode: 0 };
      if (cmd.includes("git status")) return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
      if (cmd.includes("git ls-remote")) return { stdout: "ref", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig, force: true });

    expect(report.passed).toBe(true); // Non-critical failures ignored
    expect(report.checks.filter((c) => !c.passed)).toHaveLength(2);
  });

  it("force flag still fails on critical failures", async () => {
    mockAccess.mockRejectedValue(new Error("ENOENT")); // Compose file missing (critical)

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig, force: true });

    expect(report.passed).toBe(false);
  });

  it("returns structured report with all fields", async () => {
    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report).toHaveProperty("passed");
    expect(report).toHaveProperty("checks");
    for (const check of report.checks) {
      expect(check).toHaveProperty("name");
      expect(check).toHaveProperty("passed");
      expect(check).toHaveProperty("message");
      expect(check).toHaveProperty("critical");
    }
  });

  it("fails when health endpoint is empty/whitespace", async () => {
    const config: RelayConfig = { ...baseConfig, health: "  " };

    const report = await runPreflightChecks({ appDir: "/app", config });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "health_defined");
    expect(check?.passed).toBe(false);
    expect(check?.critical).toBe(true);
  });

  it("runs all 6 checks", async () => {
    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    const names = report.checks.map((c) => c.name);
    expect(names).toContain("compose_file_exists");
    expect(names).toContain("containers_running");
    expect(names).toContain("traefik_labels");
    expect(names).toContain("health_defined");
    expect(names).toContain("git_clean");
    expect(names).toContain("git_remote_reachable");
  });

  describe("phase parameter", () => {
    it('phase: "pre-pull" runs only the git checks', async () => {
      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const names = report.checks.map((c) => c.name);
      // pre-pull is git-only: clean tree + reachable remote. Anything
      // that depends on the post-pull state (compose file, traefik
      // labels, containers, health endpoint defined in NEW config) must
      // not run here — they would either be tautological or read from
      // the wrong commit.
      expect(names).toEqual(
        expect.arrayContaining(["git_clean", "git_remote_reachable"]),
      );
      expect(names).not.toContain("compose_file_exists");
      expect(names).not.toContain("containers_running");
      expect(names).not.toContain("traefik_labels");
      expect(names).not.toContain("health_defined");
      expect(report.checks).toHaveLength(2);
    });

    it('phase: "post-pull" runs only the config/compose checks', async () => {
      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const names = report.checks.map((c) => c.name);
      // post-pull runs against the freshly-pulled tree + reloaded
      // config; the git checks are tautological after a successful pull
      // so they're skipped here.
      expect(names).toEqual(
        expect.arrayContaining([
          "compose_file_exists",
          "containers_running",
          "traefik_labels",
          "health_defined",
        ]),
      );
      expect(names).not.toContain("git_clean");
      expect(names).not.toContain("git_remote_reachable");
      expect(report.checks).toHaveLength(4);
    });

    it('phase: "all" (or omitted) runs every check, preserving back-compat for the standalone preflight endpoint', async () => {
      // The standalone GET /api/apps/:name/preflight and command-mode
      // deploys both rely on the "all" behavior — there's no natural
      // pre/post-pull split for them.
      const reportAll = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "all",
      });
      const reportDefault = await runPreflightChecks({ appDir: "/app", config: baseConfig });

      expect(reportAll.checks).toHaveLength(6);
      expect(reportDefault.checks).toHaveLength(6);
      expect(reportAll.checks.map((c) => c.name).sort()).toEqual(
        reportDefault.checks.map((c) => c.name).sort(),
      );
    });

    it('phase: "pre-pull" + dirty tree → passed=false (pre-pull gates on its own checks)', async () => {
      mockShell.mockImplementation(async (cmd) => {
        if (cmd.includes("git status")) return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
        if (cmd.includes("git ls-remote")) return { stdout: "ref", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      expect(report.passed).toBe(false);
      const dirty = report.checks.find((c) => c.name === "git_clean");
      expect(dirty?.passed).toBe(false);
      // Tighten: only the dirty check tripped — the reachable check
      // still passed. Without this assertion the test could silently
      // accept a regression that breaks both checks at once.
      const remote = report.checks.find((c) => c.name === "git_remote_reachable");
      expect(remote?.passed).toBe(true);
    });

    it('phase: "pre-pull" + force=true bypasses the gate even on a dirty tree', async () => {
      // Both pre-pull checks are non-critical. With force=true the
      // critical-only filter is empty, so passed === true regardless.
      // This is the documented escape hatch operators reach for when
      // they want to clobber WIP intentionally.
      mockShell.mockImplementation(async (cmd) => {
        if (cmd.includes("git status")) return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
        if (cmd.includes("git ls-remote")) return { stdout: "", stderr: "fatal", exitCode: 128 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
        force: true,
      });

      expect(report.passed).toBe(true);
      // Individual checks still report their real state — the report's
      // `passed` flag is the gate, not a re-write of check results.
      const dirty = report.checks.find((c) => c.name === "git_clean");
      expect(dirty?.passed).toBe(false);
    });
  });
});
