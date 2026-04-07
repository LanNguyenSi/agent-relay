import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RelayConfig } from "../config/relay.js";

// Mock exec module
vi.mock("./exec.js", () => ({
  shell: vi.fn(),
}));

// Mock health module
vi.mock("./health.js", () => ({
  checkHealth: vi.fn(),
}));

import { deploy } from "./engine.js";
import { shell } from "./exec.js";
import { checkHealth } from "./health.js";

const mockShell = vi.mocked(shell);
const mockHealth = vi.mocked(checkHealth);

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

  // Default: all shell commands succeed, return a commit SHA
  mockShell.mockImplementation(async (cmd) => {
    if (cmd.startsWith("git rev-parse")) {
      return { stdout: "abc123\n", stderr: "", exitCode: 0 };
    }
    return { stdout: "ok", stderr: "", exitCode: 0 };
  });

  mockHealth.mockResolvedValue(true);
});

describe("deploy — default flow", () => {
  it("runs full default flow successfully", async () => {
    const result = await deploy({ appDir: "/app", config: baseConfig, branch: "main" });

    expect(result.success).toBe(true);
    expect(result.commitBefore).toBe("abc123");
    expect(result.steps.map((s) => s.name)).toEqual([
      "git pull",
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

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      "pre_update: make db-generate",
      "git pull",
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

    await deploy({ appDir: "/app", config });

    const buildCall = mockShell.mock.calls.find(([cmd]) =>
      cmd.includes("compose") && cmd.includes("build"),
    );
    expect(buildCall?.[0]).toContain("docker-compose.prod.yml");
  });

  it("stops on git pull failure", async () => {
    mockShell.mockImplementation(async (cmd) => {
      if (cmd.startsWith("git rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("git pull")) {
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
    mockHealth.mockResolvedValue(false);

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
    mockHealth.mockResolvedValue(false);
    const config: RelayConfig = { ...baseConfig, rollback: false };

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(false);
    const rollbackStep = result.steps.find((s) => s.name === "rollback");
    expect(rollbackStep?.status).toBe("skipped");
  });

  it("stops on pre_update failure", async () => {
    mockShell.mockImplementation(async (cmd) => {
      if (cmd.startsWith("git rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
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

describe("deploy — custom command flow", () => {
  it("runs custom command instead of default flow", async () => {
    const config: RelayConfig = { ...baseConfig, command: "./deploy.sh" };

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(true);
    expect(result.steps.map((s) => s.name)).toEqual([
      "command: ./deploy.sh",
      "health check",
    ]);
    // No git pull, compose build/up
    expect(result.steps.find((s) => s.name === "git pull")).toBeUndefined();
  });

  it("rolls back on health failure after custom command", async () => {
    mockHealth.mockResolvedValue(false);
    const config: RelayConfig = { ...baseConfig, command: "./deploy.sh" };

    const result = await deploy({ appDir: "/app", config });

    expect(result.success).toBe(false);
    expect(result.steps.find((s) => s.name.startsWith("rollback:"))).toBeDefined();
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
