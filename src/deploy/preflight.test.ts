import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { RelayConfig } from "../config/relay.js";

vi.mock("./exec.js", () => ({
  runShell: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  access: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
  unlink: vi.fn(),
}));

// Fixed so mount-congruence assertions on the probe token / hostname-based
// docker inspect argv are deterministic across machines.
vi.mock("node:crypto", () => ({ randomUUID: () => "test-mount-probe-token" }));
vi.mock("node:os", () => ({ hostname: () => "relay-container-id" }));

import { runPreflightChecks } from "./preflight.js";
import { runExec } from "./exec.js";
import { access, readFile, stat, writeFile, unlink } from "node:fs/promises";
import { env } from "../config/env.js";

const mockRunExec = vi.mocked(runExec);
const mockAccess = vi.mocked(access);
const mockReadFile = vi.mocked(readFile);
const mockStat = vi.mocked(stat);
const mockWriteFile = vi.mocked(writeFile);
const mockUnlink = vi.mocked(unlink);

const baseConfig: RelayConfig = {
  name: "test-app",
  health: "/health",
  compose_file: "docker-compose.yml",
  pre_update: [],
  post_update: [],
  rollback: true,
};

let originalAppsDir: string;

beforeEach(() => {
  vi.resetAllMocks();

  originalAppsDir = env.APPS_DIR;
  env.APPS_DIR = "/apps";

  // Defaults: everything passes.
  // docker compose ps — non-empty stdout means containers are running.
  // git status --porcelain — empty stdout means clean tree.
  // git ls-remote — exit 0 means remote reachable.
  // access("/.dockerenv") rejects — the default test scenario is "not
  // containerized", so apps_root_mount_congruence passes trivially
  // without needing to mock docker inspect/run. access() for any other
  // path (e.g. the compose file) resolves.
  mockAccess.mockImplementation(async (path) => {
    if (path === "/.dockerenv") throw new Error("ENOENT");
    return undefined;
  });
  mockReadFile.mockResolvedValue("services:\n  app:\n    labels:\n      - traefik.enable=true\n");
  mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);
  mockWriteFile.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockRunExec.mockImplementation(async (command, args) => {
    if (command === "docker") {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 }; // containers present
    }
    if (command === "git" && args.includes("status")) {
      return { stdout: "", stderr: "", exitCode: 0 }; // clean tree
    }
    if (command === "git" && args.includes("ls-remote")) {
      return { stdout: "ref\n", stderr: "", exitCode: 0 }; // remote reachable
    }
    return { stdout: "", stderr: "", exitCode: 0 };
  });
});

afterEach(() => {
  env.APPS_DIR = originalAppsDir;
});

describe("runPreflightChecks", () => {
  it("passes when all checks succeed", async () => {
    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(true);
    expect(report.checks).toHaveLength(8);
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
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "docker") {
        return { stdout: "", stderr: "", exitCode: 0 }; // no containers
      }
      if (command === "git" && args.includes("status")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("ls-remote")) {
        return { stdout: "ref\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "containers_running");
    expect(check?.passed).toBe(false);
  });

  it("fails when traefik labels missing", async () => {
    mockReadFile.mockResolvedValue("services:\n  app:\n    image: node\n");

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "traefik_labels");
    expect(check?.passed).toBe(false);
    expect(check?.critical).toBe(false);
  });

  it("fails when git has uncommitted changes", async () => {
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "docker") {
        return { stdout: "abc\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("status")) {
        return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("ls-remote")) {
        return { stdout: "ref", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });

    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    expect(report.passed).toBe(false);
    const check = report.checks.find((c) => c.name === "git_clean");
    expect(check?.passed).toBe(false);
  });

  it("fails when git remote unreachable", async () => {
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "docker") {
        return { stdout: "abc\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("status")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("ls-remote")) {
        return { stdout: "", stderr: "fatal", exitCode: 128 };
      }
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
    mockReadFile.mockResolvedValue("services:\n  app:\n    image: node\n");
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "docker") {
        return { stdout: "abc\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("status")) {
        return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("ls-remote")) {
        return { stdout: "ref", stderr: "", exitCode: 0 };
      }
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

  it("runs all 8 checks", async () => {
    const report = await runPreflightChecks({ appDir: "/app", config: baseConfig });

    const names = report.checks.map((c) => c.name);
    expect(names).toContain("compose_file_exists");
    expect(names).toContain("containers_running");
    expect(names).toContain("traefik_labels");
    expect(names).toContain("health_defined");
    expect(names).toContain("git_clean");
    expect(names).toContain("git_remote_reachable");
    expect(names).toContain("apps_root_mount_congruence");
    expect(names).toContain("compose_bind_mount_sources_exist");
  });

  describe("phase parameter", () => {
    it('phase: "pre-pull" runs only the git checks', async () => {
      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const names = report.checks.map((c) => c.name);
      // pre-pull is git checks + apps-root mount congruence (also only
      // has signal pre-pull: it's about the host/relay APPS_DIR view,
      // not the app's tree). Anything that depends on the post-pull
      // state (compose file, traefik labels, containers, health
      // endpoint defined in NEW config) must not run here — they would
      // either be tautological or read from the wrong commit.
      expect(names).toEqual(
        expect.arrayContaining(["git_clean", "git_remote_reachable", "apps_root_mount_congruence"]),
      );
      expect(names).not.toContain("compose_file_exists");
      expect(names).not.toContain("containers_running");
      expect(names).not.toContain("traefik_labels");
      expect(names).not.toContain("health_defined");
      expect(names).not.toContain("compose_bind_mount_sources_exist");
      expect(report.checks).toHaveLength(3);
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
      // so they're skipped here. compose_bind_mount_sources_exist is
      // deliberately post-pull too — a `.relay.yml`/compose fix can land
      // in the same commit as a new bind-mount path.
      expect(names).toEqual(
        expect.arrayContaining([
          "compose_file_exists",
          "containers_running",
          "traefik_labels",
          "health_defined",
          "compose_bind_mount_sources_exist",
        ]),
      );
      expect(names).not.toContain("git_clean");
      expect(names).not.toContain("git_remote_reachable");
      expect(names).not.toContain("apps_root_mount_congruence");
      expect(report.checks).toHaveLength(5);
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

      expect(reportAll.checks).toHaveLength(8);
      expect(reportDefault.checks).toHaveLength(8);
      expect(reportAll.checks.map((c) => c.name).sort()).toEqual(
        reportDefault.checks.map((c) => c.name).sort(),
      );
    });

    it('phase: "pre-pull" + dirty tree → passed=false (pre-pull gates on its own checks)', async () => {
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "git" && args.includes("status")) {
          return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args.includes("ls-remote")) {
          return { stdout: "ref", stderr: "", exitCode: 0 };
        }
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
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "git" && args.includes("status")) {
          return { stdout: " M file.txt\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args.includes("ls-remote")) {
          return { stdout: "", stderr: "fatal", exitCode: 128 };
        }
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

  describe("apps_root_mount_congruence", () => {
    function mockContainerized() {
      mockAccess.mockImplementation(async (path) => {
        if (path === "/.dockerenv") return undefined; // containerized
        return undefined;
      });
    }

    it("passes with a note when not containerized (no /.dockerenv)", async () => {
      // Default beforeEach already mocks access("/.dockerenv") to reject.
      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(true);
      expect(check?.critical).toBe(true);
      expect(check?.message).toMatch(/not running inside a container/i);
      // Not containerized short-circuits before writing the marker or
      // shelling out to docker at all.
      expect(mockWriteFile).not.toHaveBeenCalled();
    });

    it("passes when the mount probe token round-trips through the daemon", async () => {
      mockContainerized();
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "docker" && args[0] === "inspect") {
          return { stdout: "agent-relay:latest\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args[0] === "run") {
          return { stdout: "test-mount-probe-token\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args.includes("ls-remote")) return { stdout: "ref\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(true);
      expect(mockWriteFile).toHaveBeenCalledWith(
        "/apps/.agent-relay-mount-probe",
        "test-mount-probe-token",
        "utf-8",
      );
      // Marker is always cleaned up afterwards.
      expect(mockUnlink).toHaveBeenCalledWith("/apps/.agent-relay-mount-probe");
      // Probe bind-mounts APPS_DIR read-only via --mount (never -v, which
      // would auto-create a missing source and mask the exact failure
      // mode this check exists to catch).
      const runCall = mockRunExec.mock.calls.find(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      expect(runCall?.[1]).toEqual(
        expect.arrayContaining([`--mount`, `type=bind,source=/apps,target=/probe,readonly`]),
      );
    });

    it("fails with a symlink instruction when the daemon reports the bind source is missing", async () => {
      mockContainerized();
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "docker" && args[0] === "inspect") {
          return { stdout: "agent-relay:latest\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args[0] === "run") {
          return {
            stdout: "",
            stderr:
              'Error response from daemon: invalid mount config for type "bind": bind source path does not exist: /apps',
            exitCode: 1,
          };
        }
        if (command === "git" && args.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args.includes("ls-remote")) return { stdout: "ref\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(false);
      expect(check?.critical).toBe(true);
      expect(check?.message).toMatch(/does not exist on the docker host/i);
      expect(check?.message).toMatch(/symlink/i);
      expect(report.passed).toBe(false);
      // Cleanup still attempted even on failure.
      expect(mockUnlink).toHaveBeenCalledWith("/apps/.agent-relay-mount-probe");
    });

    it("fails with a symlink instruction when the probe token does not match (host sees a different directory)", async () => {
      mockContainerized();
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "docker" && args[0] === "inspect") {
          return { stdout: "agent-relay:latest\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args[0] === "run") {
          return { stdout: "some-other-content\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args.includes("ls-remote")) return { stdout: "ref\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(false);
      expect(check?.message).toMatch(/not the same directory/i);
      expect(check?.message).toMatch(/symlink/i);
    });

    it("fails closed when the relay's own image cannot be discovered", async () => {
      mockContainerized();
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "docker" && args[0] === "inspect") {
          return { stdout: "", stderr: "no such object", exitCode: 1 };
        }
        if (command === "git" && args.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args.includes("ls-remote")) return { stdout: "ref\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(false);
      expect(check?.message).toMatch(/could not determine the relay's own docker image/i);
      // Both candidates tried: hostname first, "agent-relay" fallback.
      const inspectCalls = mockRunExec.mock.calls.filter(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "inspect",
      );
      expect(inspectCalls).toHaveLength(2);
      expect((inspectCalls[0]?.[1] as string[])[3]).toBe("relay-container-id");
      expect((inspectCalls[1]?.[1] as string[])[3]).toBe("agent-relay");
      // No probe run attempted since the image couldn't be resolved.
      const runCalls = mockRunExec.mock.calls.filter(
        (c) => c[0] === "docker" && (c[1] as string[])[0] === "run",
      );
      expect(runCalls).toHaveLength(0);
    });

    it("fails closed when writing the marker file throws", async () => {
      mockContainerized();
      mockWriteFile.mockRejectedValue(new Error("EACCES: permission denied"));

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(false);
      expect(check?.message).toContain("EACCES");
      // Cleanup is still attempted even though the write failed.
      expect(mockUnlink).toHaveBeenCalledWith("/apps/.agent-relay-mount-probe");
    });

    it("fails closed on an unexpected docker error distinct from a missing bind source", async () => {
      mockContainerized();
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "docker" && args[0] === "inspect") {
          return { stdout: "agent-relay:latest\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args[0] === "run") {
          return { stdout: "", stderr: "permission denied while trying to connect", exitCode: 125 };
        }
        if (command === "git" && args.includes("status")) return { stdout: "", stderr: "", exitCode: 0 };
        if (command === "git" && args.includes("ls-remote")) return { stdout: "ref\n", stderr: "", exitCode: 0 };
        return { stdout: "", stderr: "", exitCode: 0 };
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "pre-pull",
      });

      const check = report.checks.find((c) => c.name === "apps_root_mount_congruence");
      expect(check?.passed).toBe(false);
      expect(check?.message).toMatch(/permission denied/i);
      expect(check?.message).not.toMatch(/symlink/i);
    });
  });

  describe("compose_bind_mount_sources_exist", () => {
    it("is the REQUIRED regression test: a missing file bind-mount source fails the check and blocks the deploy", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n  app:\n    volumes:\n      - ./config/app.env:/etc/app/app.env:ro\n",
      );
      mockStat.mockImplementation(async (path) => {
        if (path === "/app/config/app.env") throw new Error("ENOENT");
        return {} as Awaited<ReturnType<typeof stat>>;
      });

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(false);
      expect(check?.critical).toBe(true);
      expect(check?.message).toContain("/app/config/app.env");
      expect(report.passed).toBe(false); // deploy is blocked
    });

    it("ignores named volumes (no host source to check)", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n  app:\n    volumes:\n      - app-data:/var/lib/app/data\n",
      );

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(true);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("skips sources with unresolved ${VAR} interpolation, with a note, and does not fail", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n  app:\n    volumes:\n      - ${DATA_DIR}/app:/data\n",
      );

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(true);
      expect(check?.message).toMatch(/interpolation/i);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("detects long-syntax `type: bind` mounts", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n  app:\n    volumes:\n      - type: bind\n        source: ./data\n        target: /data\n",
      );
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(false);
      expect(check?.message).toContain("/app/data");
    });

    it("skips absolute sources outside APPS_DIR (e.g. the docker socket) without failing", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n  app:\n    volumes:\n      - /var/run/docker.sock:/var/run/docker.sock\n",
      );

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(true);
      expect(check?.message).toMatch(/outside APPS_DIR/i);
      expect(mockStat).not.toHaveBeenCalled();
    });

    it("checks absolute sources inside APPS_DIR", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n  app:\n    volumes:\n      - /apps/shared/config.json:/etc/config.json:ro\n",
      );
      mockStat.mockRejectedValue(new Error("ENOENT"));

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(false);
      expect(check?.message).toContain("/apps/shared/config.json");
    });

    it("fails closed on unparseable YAML", async () => {
      mockReadFile.mockResolvedValue("services:\n  app:\n  volumes: [\n");

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(false);
      expect(check?.critical).toBe(true);
    });

    it("fails closed when the compose file cannot be read", async () => {
      mockReadFile.mockRejectedValue(new Error("EACCES: permission denied"));

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(false);
      expect(check?.critical).toBe(true);
      expect(check?.message).toContain("EACCES");
    });

    it("fails closed when the compose file parses to a non-mapping YAML document", async () => {
      mockReadFile.mockResolvedValue("- just\n- a\n- list\n");

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(false);
      expect(check?.critical).toBe(true);
    });

    it("passes when all bind-mount sources exist, including configs/secrets file: entries", async () => {
      mockReadFile.mockResolvedValue(
        "services:\n" +
          "  app:\n" +
          "    volumes:\n" +
          "      - ./data:/data\n" +
          "configs:\n" +
          "  app_config:\n" +
          "    file: ./config/app.yml\n" +
          "secrets:\n" +
          "  app_secret:\n" +
          "    file: ./secrets/app.key\n",
      );
      mockStat.mockResolvedValue({} as Awaited<ReturnType<typeof stat>>);

      const report = await runPreflightChecks({
        appDir: "/app",
        config: baseConfig,
        phase: "post-pull",
      });

      const check = report.checks.find((c) => c.name === "compose_bind_mount_sources_exist");
      expect(check?.passed).toBe(true);
      expect(mockStat).toHaveBeenCalledWith("/app/data");
      expect(mockStat).toHaveBeenCalledWith("/app/config/app.yml");
      expect(mockStat).toHaveBeenCalledWith("/app/secrets/app.key");
    });
  });
});
