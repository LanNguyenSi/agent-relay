/**
 * Pins that the health-check retry delay no longer reads NODE_ENV.
 * vitest runs with NODE_ENV=test; this file never calls
 * setHealthCheckRetryDelayMsForTests, so the engine module keeps its
 * production default (HEALTH_CHECK_RETRY_DELAY_MS = 5000). setTimeout is
 * stubbed to record the delay argument and fire immediately, so the test
 * asserts the value passed to the timer instead of waiting 5 s.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { RelayConfig } from "../config/relay.js";

// Mock exec module
vi.mock("./exec.js", () => ({
  runShell: vi.fn(),
  runExec: vi.fn(),
}));

vi.mock("./preflight.js", async () => {
  const actual = await vi.importActual<typeof import("./preflight.js")>(
    "./preflight.js",
  );
  return {
    ...actual,
    runPreflightChecks: vi.fn(),
  };
});

vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>(
    "../config/relay.js",
  );
  return { ...actual, loadRelayConfig: vi.fn() };
});

import { deploy, HEALTH_CHECK_RETRY_DELAY_MS } from "./engine.js";
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
  health_port: 3000,
  compose_file: "docker-compose.yml",
  pre_update: [],
  post_update: [],
  rollback: true,
};

describe("health-check retry delay default", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("waits the 5000 ms default between attempts under NODE_ENV=test with no override", async () => {
    // The premise: vitest sets NODE_ENV=test, and no test override was
    // applied in this module instance (no setter call in this file).
    expect(process.env.NODE_ENV).toBe("test");
    expect(HEALTH_CHECK_RETRY_DELAY_MS).toBe(5000);

    const timerDelays: number[] = [];
    vi.stubGlobal(
      "setTimeout",
      (fn: () => void, delayMs?: number) => {
        timerDelays.push(delayMs ?? 0);
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );

    mockRunShell.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    mockLoadRelayConfig.mockResolvedValue(baseConfig);
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });

    // First health probe fails, the retry's first probe succeeds: exactly
    // one delay is awaited, and the deploy still succeeds.
    let probes = 0;
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("--status")) {
        return { stdout: "app\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("node") && args.includes("-e")) {
        probes += 1;
        return probes === 1
          ? { stdout: "HTTP_STATUS=503", stderr: "", exitCode: 1 }
          : { stdout: "HTTP_STATUS=200", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });

    const result = await deploy({ appDir: "/app", config: baseConfig, branch: "main" });

    expect(result.success).toBe(true);
    expect(result.steps.find((s) => s.name === "health check")?.output).toContain("(attempt 2)");
    expect(timerDelays).toEqual([HEALTH_CHECK_RETRY_DELAY_MS]);
  });
});

// `health_interval_seconds` alone and `health_retries` +
// `health_interval_seconds` together, observable here because this file
// never calls setHealthCheckRetryDelayMsForTests, so the config (not the
// test override) drives the timer. The absent case is the test above:
// 5 attempts at HEALTH_CHECK_RETRY_DELAY_MS.
describe("health interval from .relay.yml", () => {
  function stubTimers(delays: number[]) {
    vi.stubGlobal(
      "setTimeout",
      (fn: () => void, delayMs?: number) => {
        delays.push(delayMs ?? 0);
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      },
    );
  }

  function mockProbes(failFirstOnly: boolean) {
    let probes = 0;
    mockRunExec.mockImplementation(async (command, args) => {
      if (command === "git" && args.includes("rev-parse")) {
        return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("--status")) {
        return { stdout: "app\n", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("node") && args.includes("-e")) {
        probes += 1;
        if (!failFirstOnly) {
          return { stdout: "HTTP_STATUS=503", stderr: "", exitCode: 1 };
        }
        return probes === 1
          ? { stdout: "HTTP_STATUS=503", stderr: "", exitCode: 1 }
          : { stdout: "HTTP_STATUS=200", stderr: "", exitCode: 0 };
      }
      if (command === "docker" && args.includes("logs")) {
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "ok", stderr: "", exitCode: 0 };
    });
    return () => probes;
  }

  it("waits health_interval_seconds (not the 5 s default) between attempts when only the interval is set", async () => {
    const timerDelays: number[] = [];
    stubTimers(timerDelays);
    mockRunShell.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    mockLoadRelayConfig.mockResolvedValue({
      ...baseConfig,
      health_interval_seconds: 9,
    });
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });
    const probes = mockProbes(true);

    const result = await deploy({ appDir: "/app", config: { ...baseConfig, health_interval_seconds: 9 }, branch: "main" });

    expect(result.success).toBe(true);
    expect(probes()).toBe(2);
    expect(timerDelays).toEqual([9000]);
    expect(timerDelays).not.toEqual([HEALTH_CHECK_RETRY_DELAY_MS]);
  });

  it("uses both health_retries and health_interval_seconds together when set", async () => {
    const timerDelays: number[] = [];
    stubTimers(timerDelays);
    mockRunShell.mockResolvedValue({ stdout: "ok", stderr: "", exitCode: 0 });
    const config: RelayConfig = {
      ...baseConfig,
      rollback: false, // no second health loop from the rollback tail
      health_retries: 2,
      health_interval_seconds: 4,
    };
    mockLoadRelayConfig.mockResolvedValue(config);
    mockRunPreflightChecks.mockResolvedValue({ passed: true, checks: [] });
    const probes = mockProbes(false);

    const result = await deploy({ appDir: "/app", config, branch: "main" });

    expect(result.success).toBe(false);
    // 2 attempts -> exactly one inter-attempt pause, at the configured 4 s.
    expect(probes()).toBe(2);
    expect(timerDelays).toEqual([4000]);
    expect(result.steps.find((s) => s.name === "health check")?.output).toContain("after 2 attempts");
  });
});
