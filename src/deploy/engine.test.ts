import { describe, it, expect, vi, beforeEach } from "vitest";
import { RelayConfigError, type RelayConfig } from "../config/relay.js";

// Mock exec module
vi.mock("./exec.js", () => ({
  runShell: vi.fn(),
  runExec: vi.fn(),
}));

// Mock preflight — the engine now runs it after git pull + reload. Most
// tests in this file don't care about preflight details; keep it passing
// by default. Dedicated preflight tests (the `preflight gate` describe
// below) override per-test.
vi.mock("./preflight.js", async () => {
  const actual = await vi.importActual<typeof import("./preflight.js")>(
    "./preflight.js",
  );
  return {
    ...actual,
    runPreflightChecks: vi.fn(),
  };
});

// Mock loadRelayConfig so we can simulate `.relay.yml` mutating between
// the pre-pull load (in services/apps.ts) and the post-pull reload (in
// engine.ts). By default it returns whatever config the test passed in;
// the bug-regression suite below overrides it per-test.
vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>(
    "../config/relay.js",
  );
  return { ...actual, loadRelayConfig: vi.fn() };
});

import { deploy } from "./engine.js";
import { runShell, runExec } from "./exec.js";
import { loadRelayConfig } from "../config/relay.js";
import { runPreflightChecks } from "./preflight.js";

const mockRunShell = vi.mocked(runShell);
const mockRunExec = vi.mocked(runExec);
const mockLoadRelayConfig = vi.mocked(loadRelayConfig);
const mockRunPreflightChecks = vi.mocked(runPreflightChecks);

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

  // Default: all runExec calls succeed; git rev-parse returns a commit SHA.
  mockRunExec.mockImplementation(async (command, args) => {
    if (command === "git" && args.includes("rev-parse")) {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "ok", stderr: "", exitCode: 0 };
  });

  // Default: runShell calls (pre_update / post_update / command) succeed.
  mockRunShell.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });

  // Default: post-pull reload returns the same config as the caller passed.
  // Tests that care about the pre/post-pull divergence override this.
  mockLoadRelayConfig.mockImplementation(async () => baseConfig);

  // Default: preflight passes. Preflight-specific tests override.
  mockRunPreflightChecks.mockResolvedValue({
    passed: true,
    checks: [
      { name: "compose_file_exists", passed: true, message: "ok", critical: true },
      { name: "health_defined", passed: true, message: "ok", critical: true },
    ],
  });
});

describe("deploy — default flow", () => {
  it("runs full default flow successfully", async () => {
    const result = await deploy({ appDir: "/app", config: baseConfig, branch: "main" });

    expect(result.success).toBe(true);
    expect(result.commitBefore).toBe("abc123");
    expect(result.steps.map((s) => s.name)).toEqual([
      "preflight (pre-pull)",
      "git pull",
      "reload .relay.yml",
      "preflight (post-pull)",
      "compose build",
      "compose up",
      "health check",
    ]);
    expect(result.steps.every((s) => s.status === "success")).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("runs pre_update and post_update commands", async () => {
    const config: RelayConfig = {
      ...baseConfig,
      pre_update: ["make db-generate"],
      post_update: ["npx prisma migrate deploy"],
    };
    mockLoadRelayConfig.mockResolvedValue(config);

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      "preflight (pre-pull)",
      "pre_update: make db-generate",
      "git pull",
      "reload .relay.yml",
      "preflight (post-pull)",
      "compose build",
      "compose up",
      "post_update: npx prisma migrate deploy",
      "health check",
    ]);
  });

  it("uses custom compose file", async () => {
    const config: RelayConfig = {
      ...baseConfig,
      compose_file: "docker-compose.prod.yml",
    };
    mockLoadRelayConfig.mockResolvedValue(config);

    await deploy({ appDir: "/app", config });

    const buildCall = mockRunExec.mock.calls.find(
      ([cmd, args]) => cmd === "docker" && args.includes("compose") && args.includes("build"),
    );
    expect(buildCall?.[1]).toContain("docker-compose.prod.yml");
  });

  it("stops on git pull failure", async () => {
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args[0] === "pull") {
        return { stdout: "", stderr: "merge conflict", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const result = await deploy({ appDir: "/app", config: baseConfig });

    expect(result.success).toBe(false);
    const pullStep = result.steps.find((s) => s.name === "git pull");
    expect(pullStep?.status).toBe("failure");
    // No compose build/up should follow
    expect(result.steps.find((s) => s.name === "compose build")).toBeUndefined();
  });

  it("rolls back on health check failure", async () => {
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse") && !args.includes("--abbrev-ref")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("--abbrev-ref")) {
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      }
      // docker ps --services --status running
      if (command === "docker" && args.includes("--status")) {
        return { stdout: "app\n", stderr: "", exitCode: 0 };
      }
      // docker exec -T ... node -e (health check)
      if (command === "docker" && args.includes("node") && args.includes("-e")) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const result = await deploy({ appDir: "/app", config: baseConfig });

    expect(result.success).toBe(false);
    const rollbackSteps = result.steps.filter((s) => s.name.startsWith("rollback:"));
    expect(rollbackSteps.length).toBe(3);
    expect(rollbackSteps.map((s) => s.name)).toEqual([
      "rollback: git reset",
      "rollback: compose build",
      "rollback: compose up",
    ]);
  });

  it("skips rollback when disabled", async () => {
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse") && !args.includes("--abbrev-ref")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (command === "git" && args.includes("--abbrev-ref")) {
        return { stdout: "main\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("--status")) {
        return { stdout: "app\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("node") && args.includes("-e")) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const config: RelayConfig = { ...baseConfig, rollback: false };

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(false);
    const rollbackStep = result.steps.find((s) => s.name === "rollback");
    expect(rollbackStep?.status).toBe("skipped");
  });

  // Regression for https://github.com/LanNguyenSi/agent-tasks task 7183a634:
  // .relay.yml read before git pull → config changes took 2 deploys to apply.
  describe("post-pull config reload", () => {
    it("uses post-pull config for compose_file, post_update, health_port", async () => {
      const prePull: RelayConfig = {
        ...baseConfig,
        compose_file: "docker-compose.yml",
        post_update: [],
        health_port: 3000,
      };
      const postPull: RelayConfig = {
        ...baseConfig,
        compose_file: "docker-compose.prod.yml",
        post_update: ["npx prisma db push --accept-data-loss"],
        health_port: 4000,
      };
      mockLoadRelayConfig.mockResolvedValue(postPull);

      const result = await deploy({ appDir: "/app", config: prePull });
      expect(result.success).toBe(true);

      // compose build/up must reference the NEW compose_file (as array element, no quotes)
      const buildCall = mockRunExec.mock.calls.find(
        ([cmd, args]) => cmd === "docker" && args.includes("compose") && args.includes("build"),
      );
      expect(buildCall?.[1]).toContain("docker-compose.prod.yml");
      expect(buildCall?.[1]).not.toContain("docker-compose.yml");

      // post_update from the NEW config must run via runShell
      const shellCmds = mockRunShell.mock.calls.map(([c]) => c);
      expect(shellCmds).toContain("npx prisma db push --accept-data-loss");

      // health check must probe the NEW health_port
      const healthExecCall = mockRunExec.mock.calls.find(
        ([cmd, args]) => cmd === "docker" && args.includes("node") && args.includes("-e"),
      );
      const jsSnippet = healthExecCall?.[1].at(-1) ?? "";
      expect(jsSnippet).toContain("localhost:4000");
      expect(jsSnippet).not.toContain("localhost:3000");
    });

    it("uses pre-pull config for pre_update (runs before git pull)", async () => {
      const prePull: RelayConfig = {
        ...baseConfig,
        pre_update: ["echo from-old-config"],
      };
      const postPull: RelayConfig = {
        ...baseConfig,
        pre_update: ["echo from-new-config"],
      };
      mockLoadRelayConfig.mockResolvedValue(postPull);

      await deploy({ appDir: "/app", config: prePull });

      const shellCmds = mockRunShell.mock.calls.map(([c]) => c);
      expect(shellCmds).toContain("echo from-old-config");
      expect(shellCmds).not.toContain("echo from-new-config");
    });

    it("rolls back using pre-pull compose_file when reload fails", async () => {
      const prePull: RelayConfig = {
        ...baseConfig,
        compose_file: "docker-compose.yml",
      };
      mockLoadRelayConfig.mockRejectedValue(
        new RelayConfigError("Invalid .relay.yml: missing 'name'"),
      );

      const result = await deploy({ appDir: "/app", config: prePull });
      expect(result.success).toBe(false);

      const reloadStep = result.steps.find((s) => s.name === "reload .relay.yml");
      expect(reloadStep?.status).toBe("failure");
      expect(reloadStep?.output).toContain("missing 'name'");

      // Rollback must have fired (config was on a bad commit) and used the
      // OLD compose_file — `git reset --hard` restored the OLD tree, so the
      // NEW compose_file path may not exist.
      const rollbackBuild = result.steps.find(
        (s) => s.name === "rollback: compose build",
      );
      expect(rollbackBuild?.status).toBe("success");
      const rollbackBuildCalls = mockRunExec.mock.calls
        .filter(([cmd, args]) => cmd === "docker" && args.includes("compose") && args.includes("build"));
      // Last build call must use the pre-pull compose_file (as a plain array element)
      expect(rollbackBuildCalls.at(-1)?.[1]).toContain("docker-compose.yml");
    });

    it("rollback boolean honors pre-pull config, not post-pull", async () => {
      // Intentional invariant: rollback is a safety net. An operator
      // shipping a bad commit that ALSO disables rollback in the same
      // commit should NOT be able to strand the server — the pre-pull
      // `rollback: true` keeps the safety net on for the deploy that
      // introduces the change. Flipping to `rollback: false` only takes
      // effect on the NEXT deploy.
      const prePull: RelayConfig = { ...baseConfig, rollback: true };
      const postPull: RelayConfig = { ...baseConfig, rollback: false };
      mockLoadRelayConfig.mockResolvedValue(postPull);
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "git" && args.includes("rev-parse") && !args.includes("--abbrev-ref")) {
          return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        }
        if (command === "git" && args.includes("--abbrev-ref")) {
          return { stdout: "main\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args.includes("--status")) {
          return { stdout: "app\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args.includes("node") && args.includes("-e")) {
          return { stdout: "", stderr: "", exitCode: 1 }; // health fails
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      const result = await deploy({ appDir: "/app", config: prePull });

      expect(result.success).toBe(false);
      // Pre-pull rollback=true wins: rollback steps must fire
      const rollbackSteps = result.steps.filter((s) => s.name.startsWith("rollback:"));
      expect(rollbackSteps.length).toBe(3);
      // Verify the skipped-rollback branch did NOT fire (would have produced
      // a single "rollback" step with status=skipped)
      expect(result.steps.find((s) => s.name === "rollback" && s.status === "skipped"))
        .toBeUndefined();
    });

    it("emits `reload .relay.yml` on the onStep stream", async () => {
      const seen: string[] = [];
      await deploy({
        appDir: "/app",
        config: baseConfig,
        onStep: (s) => seen.push(s.name),
      });
      expect(seen).toContain("reload .relay.yml");
      // Must appear between git pull and compose build
      expect(seen.indexOf("reload .relay.yml")).toBeGreaterThan(seen.indexOf("git pull"));
      expect(seen.indexOf("reload .relay.yml")).toBeLessThan(seen.indexOf("compose build"));
    });

    it("rollback after post-pull build failure uses pre-pull compose_file", async () => {
      // Scenario: the pulled commit has a syntactically valid .relay.yml but
      // it points compose_file at a path that the new tree does not actually
      // contain. compose build fails. Rollback resets the tree to the OLD
      // commit and must compose-build using the OLD compose_file (the path
      // that exists at commitBefore), not the broken NEW one.
      const prePull: RelayConfig = {
        ...baseConfig,
        compose_file: "docker-compose.yml",
      };
      const postPull: RelayConfig = {
        ...baseConfig,
        compose_file: "missing/compose.yml",
      };
      mockLoadRelayConfig.mockResolvedValue(postPull);
      mockRunExec.mockImplementation(async (command, args) => {
        if (command === "git" && args.includes("rev-parse")) {
          return { stdout: "abc123\n", stderr: "", exitCode: 0 };
        }
        if (command === "docker" && args.includes("missing/compose.yml") && args.includes("build")) {
          return { stdout: "", stderr: "no such file", exitCode: 1 };
        }
        return { stdout: "ok", stderr: "", exitCode: 0 };
      });

      const result = await deploy({ appDir: "/app", config: prePull });
      expect(result.success).toBe(false);

      const rollbackBuild = result.steps.find(
        (s) => s.name === "rollback: compose build",
      );
      expect(rollbackBuild).toBeDefined();
      const buildCalls = mockRunExec.mock.calls
        .filter(([cmd, args]) => cmd === "docker" && args.includes("compose") && args.includes("build"));
      const lastBuildArgs = buildCalls.at(-1)?.[1];
      // Last build must use the OLD compose_file as a plain array element (no shell quotes)
      expect(lastBuildArgs).toContain("docker-compose.yml");
      expect(lastBuildArgs).not.toContain("missing/compose.yml");
    });
  });

  it("stops on pre_update failure", async () => {
    mockRunShell.mockImplementation(async (cmd) => {
      if (cmd === "make db-generate") {
        return { stdout: "", stderr: "error", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const config: RelayConfig = { ...baseConfig, pre_update: ["make db-generate"] };
    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(false);
    expect(result.steps.find((s) => s.name === "git pull")).toBeUndefined();
  });
});

// Regression for agent-tasks task 1210d61f:
// Preflight used to run in services/apps.ts BEFORE git pull, so a commit
// that fixed a broken .relay.yml never got applied — preflight kept failing
// against the stale pre-pull config on disk. Preflight now runs inside
// deploy() after pull+reload, so the merged fix wins on the first deploy.
describe("deploy — preflight gate", () => {
  it("runs post-pull preflight AFTER git pull + reload (default flow)", async () => {
    const onStep = vi.fn();
    const result = await deploy({ appDir: "/app", config: baseConfig, onStep });
    expect(result.success).toBe(true);
    const names = result.steps.map((s) => s.name);
    // Ordering invariant: pre-pull → pull → reload → post-pull → build.
    expect(names.indexOf("preflight (pre-pull)")).toBeLessThan(names.indexOf("git pull"));
    expect(names.indexOf("preflight (post-pull)")).toBeGreaterThan(names.indexOf("git pull"));
    expect(names.indexOf("preflight (post-pull)")).toBeGreaterThan(
      names.indexOf("reload .relay.yml"),
    );
    expect(names.indexOf("preflight (post-pull)")).toBeLessThan(names.indexOf("compose build"));
  });

  it("regression: preflight against a broken pre-pull config but fixed post-pull config SUCCEEDS", async () => {
    // Scenario: a commit fixes .relay.yml (pre-pull = busted, post-pull = ok).
    // Pre-PR: deployAppStreaming read pre-pull config → preflight failed →
    // deploy never reached git pull → broken config stays on disk → next
    // deploy repeats the same failure forever. Operator workaround was SSH
    // + manual `git pull`.
    //
    // Post-PR: post-pull preflight sees the fixed config. The pre-pull
    // preflight only runs git checks (clean tree + reachable remote), so
    // a busted compose_file in the pre-pull config doesn't block here.
    const prePullBusted: RelayConfig = {
      ...baseConfig,
      // Points at a non-compose file — mimics the agent-planforge #63 bug.
      compose_file: "server/Dockerfile",
    };
    const postPullFixed: RelayConfig = {
      ...baseConfig,
      compose_file: "docker-compose.yml",
    };
    mockLoadRelayConfig.mockResolvedValue(postPullFixed);
    // Phase-aware mock: pre-pull is git-only (always passes here),
    // post-pull validates compose_file (passes only on the fixed config).
    mockRunPreflightChecks.mockImplementation(async (opts) => {
      if (opts.phase === "pre-pull") {
        return { passed: true, checks: [] };
      }
      if (opts.config.compose_file === "docker-compose.yml") {
        return { passed: true, checks: [] };
      }
      return {
        passed: false,
        checks: [
          { name: "compose_file_exists", passed: false, message: "bad file", critical: true },
        ],
      };
    });

    const result = await deploy({ appDir: "/app", config: prePullBusted });
    expect(result.success).toBe(true);
    expect("blocked" in result && result.blocked).toBeFalsy();
    // Two preflight invocations now: pre-pull (busted config, git phase)
    // then post-pull (fixed config, config phase). The post-pull call is
    // what actually validates compose_file_exists.
    const calls = mockRunPreflightChecks.mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[0][0].phase).toBe("pre-pull");
    expect(calls[1][0].phase).toBe("post-pull");
    expect(calls[1][0].config.compose_file).toBe("docker-compose.yml");
  });

  it("blocks the deploy with a DeployBlockedResult when post-pull preflight fails", async () => {
    // Pre-pull passes (default mock), post-pull fails. The blocked
    // result must carry the post-pull report and the step list must
    // include the post-pull preflight as a failure but stop before
    // compose build / up.
    mockRunPreflightChecks.mockImplementation(async (opts) => {
      if (opts.phase === "pre-pull") {
        return { passed: true, checks: [] };
      }
      return {
        passed: false,
        checks: [
          { name: "compose_file_exists", passed: false, message: "not found", critical: true },
          { name: "health_defined", passed: true, message: "/health", critical: true },
        ],
      };
    });

    const result = await deploy({ appDir: "/app", config: baseConfig });
    expect(result.success).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
    if ("blocked" in result) {
      expect(result.preflight.passed).toBe(false);
      expect(result.preflight.checks).toHaveLength(2);
      const postPullStep = result.steps.find((s) => s.name === "preflight (post-pull)");
      expect(postPullStep?.status).toBe("failure");
      // No compose build / up ran — we aborted before them
      expect(result.steps.find((s) => s.name === "compose build")).toBeUndefined();
    }
  });

  it("blocks the deploy BEFORE git pull when pre-pull preflight fails (dirty tree)", async () => {
    // The whole point of having a pre-pull phase: catch a dirty working
    // tree before `git pull` clobbers it. Asserting that `git pull`
    // never ran is half the contract; the other half is that the
    // blocked result carries the pre-pull report, not a stale
    // "everything passed" one.
    mockRunPreflightChecks.mockImplementation(async (opts) => {
      if (opts.phase === "pre-pull") {
        return {
          passed: false,
          checks: [
            { name: "git_clean", passed: false, message: "Uncommitted changes", critical: false },
          ],
        };
      }
      return { passed: true, checks: [] };
    });

    const result = await deploy({ appDir: "/app", config: baseConfig });
    expect(result.success).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
    // git pull MUST NOT have been invoked.
    const gitPullCall = mockRunExec.mock.calls.find(
      ([cmd, args]) => cmd === "git" && args[0] === "pull",
    );
    expect(gitPullCall).toBeUndefined();
    // post-pull preflight must NOT have been called either — we
    // short-circuited at the pre-pull gate.
    const postPullCall = mockRunPreflightChecks.mock.calls.find(
      (c) => c[0].phase === "post-pull",
    );
    expect(postPullCall).toBeUndefined();
    // Step list stops at preflight (pre-pull) as a failure.
    if ("blocked" in result) {
      const prePullStep = result.steps.find((s) => s.name === "preflight (pre-pull)");
      expect(prePullStep?.status).toBe("failure");
      expect(result.steps.find((s) => s.name === "git pull")).toBeUndefined();
      expect(result.steps.find((s) => s.name === "compose build")).toBeUndefined();
    }
  });

  it("command-mode preflight runs BEFORE the command (pre-pull gate preserved)", async () => {
    // Command mode is opaque — the command may or may not pull, so preflight
    // happens pre-command against whatever .relay.yml is on disk. This
    // matches the pre-PR behavior for command mode.
    const config: RelayConfig = { ...baseConfig, command: "./custom.sh" };
    const result = await deploy({ appDir: "/app", config });
    expect(result.success).toBe(true);
    const names = result.steps.map((s) => s.name);
    expect(names.indexOf("preflight")).toBe(0);
    expect(names.indexOf("preflight")).toBeLessThan(names.indexOf("command: ./custom.sh"));
  });

  it("command-mode preflight failure blocks before the command runs", async () => {
    mockRunPreflightChecks.mockResolvedValue({
      passed: false,
      checks: [{ name: "compose_file_exists", passed: false, message: "x", critical: true }],
    });
    const config: RelayConfig = { ...baseConfig, command: "./custom.sh" };
    const result = await deploy({ appDir: "/app", config });
    expect(result.success).toBe(false);
    expect("blocked" in result && result.blocked).toBe(true);
    expect(result.steps.find((s) => s.name.startsWith("command:"))).toBeUndefined();
  });

  it("propagates `force` into preflight (non-critical checks skipped)", async () => {
    await deploy({ appDir: "/app", config: baseConfig, force: true });
    const callArgs = mockRunPreflightChecks.mock.calls[0][0];
    expect(callArgs.force).toBe(true);
  });
});

describe("deploy — custom command flow", () => {
  it("runs custom command instead of default flow", async () => {
    const config: RelayConfig = { ...baseConfig, command: "./deploy.sh" };

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      "preflight",
      "command: ./deploy.sh",
      "reload .relay.yml",
      "health check",
    ]);
    // No git pull, compose build/up
    expect(result.steps.find((s) => s.name === "git pull")).toBeUndefined();
  });

  it("rolls back on health failure after custom command", async () => {
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("--status")) {
        return { stdout: "app\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("node") && args.includes("-e")) {
        return { stdout: "", stderr: "", exitCode: 1 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    const config: RelayConfig = { ...baseConfig, command: "./deploy.sh" };

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(false);
    expect(result.steps.find((s) => s.name.startsWith("rollback:"))).toBeDefined();
  });

  it("reloads .relay.yml after the custom command so health uses post-command config", async () => {
    const preCommand: RelayConfig = { ...baseConfig, command: "./deploy.sh", health: "/old-health" };
    const postCommand: RelayConfig = { ...baseConfig, command: "./deploy.sh", health: "/new-health" };
    mockLoadRelayConfig.mockResolvedValue(postCommand);

    let probedPath = "";
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { stdout: "abc\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("--status")) {
        return { stdout: "app\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("node") && args.includes("-e")) {
        const jsSnippet = args.at(-1) ?? "";
        const match = jsSnippet.match(/fetch\('http:\/\/localhost:\d+(\/[^']+)'\)/);
        if (match) probedPath = match[1]!;
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const result = await deploy({ appDir: "/app", config: preCommand });

    expect(result.success).toBe(true);
    expect(probedPath).toBe("/new-health");
  });

  it("rolls back with pre-command config when reload fails", async () => {
    const preCommand: RelayConfig = { ...baseConfig, command: "./deploy.sh", compose_file: "pre.yml" };
    mockLoadRelayConfig.mockRejectedValue(
      new (await import("../config/relay.js")).RelayConfigError("Invalid .relay.yml:\n  name: required"),
    );

    const result = await deploy({ appDir: "/app", config: preCommand });

    expect(result.success).toBe(false);
    const reloadStep = result.steps.find((s) => s.name === "reload .relay.yml");
    expect(reloadStep?.status).toBe("failure");
    expect(reloadStep?.output).toContain("Invalid .relay.yml");
    // Rollback uses pre-command compose_file.
    const rollbackBuild = result.steps.find((s) => s.name === "rollback: compose build");
    expect(rollbackBuild).toBeDefined();
    const rollbackRebuild = mockRunExec.mock.calls.find(
      ([cmd, args]) => cmd === "docker" && args.includes("compose") && args.includes("pre.yml") && args.includes("build"),
    );
    expect(rollbackRebuild).toBeDefined();
    // Health check must not have run — reload failed before it.
    expect(result.steps.find((s) => s.name === "health check")).toBeUndefined();
  });

  it("emits reload .relay.yml on the onStep stream after command", async () => {
    const config: RelayConfig = { ...baseConfig, command: "./deploy.sh" };
    const seen: string[] = [];
    await deploy({ appDir: "/app", config, onStep: (s) => seen.push(s.name) });

    expect(seen).toContain("reload .relay.yml");
    expect(seen.indexOf("reload .relay.yml")).toBeGreaterThan(seen.indexOf("command: ./deploy.sh"));
    expect(seen.indexOf("reload .relay.yml")).toBeLessThan(seen.indexOf("health check"));
  });
});

describe("deploy — result structure", () => {
  it("returns structured result with all fields", async () => {
    const result = await deploy({ appDir: "/app", config: baseConfig });

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("durationMs");
    expect(result).toHaveProperty("commitBefore");
    expect(result).toHaveProperty("commitAfter");
    expect(result).toHaveProperty("steps");
    for (const step of result.steps) {
      expect(step).toHaveProperty("name");
      expect(step).toHaveProperty("status");
      expect(step).toHaveProperty("output");
      expect(step).toHaveProperty("durationMs");
    }
  });
});

// Regression: shell metacharacters in compose_file must never be shell-expanded.
// If engine.ts used shell() with ${config.compose_file} interpolation, a
// malicious compose_file value like "docker-compose.yml;rm -rf /" would be
// executed by /bin/sh. With runExec the value is passed as a standalone array
// element — inert to the shell.
describe("injection guard — compose_file metacharacters are never shell-interpreted", () => {
  it("passes compose_file with shell metacharacters as a literal array element to runExec", async () => {
    const injected = "docker-compose.yml;rm -rf /";
    const maliciousConfig: RelayConfig = {
      ...baseConfig,
      compose_file: injected,
    };
    // Also override loadRelayConfig so the post-pull reload returns the malicious config,
    // ensuring the build/up/health steps all exercise the injection path.
    mockLoadRelayConfig.mockResolvedValue(maliciousConfig);

    await deploy({ appDir: "/app", config: maliciousConfig, branch: "main" });

    // At least one docker compose call must carry the metacharacter value.
    const composeCalls = mockRunExec.mock.calls.filter(
      ([cmd, args]) => cmd === "docker" && Array.isArray(args) && args.includes(injected),
    );
    expect(composeCalls.length).toBeGreaterThan(0);

    // In every such call the compose_file appears directly after the -f flag
    // as a complete, unbroken array element — not split or shell-interpreted.
    for (const [, args] of composeCalls) {
      const dashFIdx = args.indexOf("-f");
      expect(dashFIdx).toBeGreaterThanOrEqual(0);
      expect(args[dashFIdx + 1]).toBe(injected);
    }
  });
});
