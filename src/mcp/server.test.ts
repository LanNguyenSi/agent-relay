/**
 * Tests for the MCP tool handlers in src/mcp/server.ts.
 * Verifies try/catch ok/err wrapping, blocked-deploy branch,
 * COMMIT_REF/SERVICE_NAME regex validation, and recordDeploy side-effect.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test.
vi.mock("../services/apps.js", () => ({
  deployApp: vi.fn(),
  getAppDetail: vi.fn(),
  listApps: vi.fn(),
  rollbackApp: vi.fn(),
  fetchLogs: vi.fn(),
  runPreflight: vi.fn(),
}));

vi.mock("../services/history.js", () => ({
  recordDeploy: vi.fn(),
  getHistory: vi.fn(),
}));

import { createMcpServer } from "./server.js";
import * as apps from "../services/apps.js";
import * as historyMod from "../services/history.js";

const mockDeployApp = vi.mocked(apps.deployApp);
const mockGetAppDetail = vi.mocked(apps.getAppDetail);
const mockListApps = vi.mocked(apps.listApps);
const mockRollbackApp = vi.mocked(apps.rollbackApp);
const mockFetchLogs = vi.mocked(apps.fetchLogs);
const mockRunPreflight = vi.mocked(apps.runPreflight);
const mockRecordDeploy = vi.mocked(historyMod.recordDeploy);

// The MCP SDK stores registered tools in `_registeredTools`. Each entry has
// a `handler` (the async callback) and an `inputSchema` (a zod object).
type RegistryEntry = { handler: (...args: unknown[]) => Promise<unknown>; inputSchema?: { safeParse: (v: unknown) => { success: boolean } } };
type ToolResult = { content: Array<{ type: string; text: string }>; isError?: true };

function getTools(): Record<string, RegistryEntry> {
  const server = createMcpServer();
  return (server as unknown as { _registeredTools: Record<string, RegistryEntry> })._registeredTools;
}

function parseResult(raw: unknown): unknown {
  const r = raw as ToolResult;
  return JSON.parse(r.content[0]!.text);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── relay_deploy ─────────────────────────────────────────────────────────────

describe("relay_deploy", () => {
  it("returns ok result and calls recordDeploy on success", async () => {
    const successResult = { success: true, commitBefore: "aaa", commitAfter: "bbb", durationMs: 10, steps: [] };
    mockDeployApp.mockResolvedValue(successResult as never);
    const fakeRecord = { id: "d-1" };
    mockRecordDeploy.mockResolvedValue(fakeRecord as never);

    const tools = getTools();
    const raw = await tools["relay_deploy"]!.handler({ app: "myapp", branch: "main" });
    const result = parseResult(raw);

    expect(result).toEqual(successResult);
    expect(mockRecordDeploy).toHaveBeenCalledOnce();
    expect(mockRecordDeploy).toHaveBeenCalledWith("myapp", successResult, "mcp");
    expect((raw as ToolResult).isError).toBeUndefined();
  });

  it("returns ok result but does NOT call recordDeploy when deploy is blocked", async () => {
    const blockedResult = {
      success: false,
      blocked: true,
      preflight: { ok: false, checks: [] },
      durationMs: 0,
      commitBefore: "abc",
      commitAfter: "abc",
      steps: [],
    };
    mockDeployApp.mockResolvedValue(blockedResult as never);

    const tools = getTools();
    const raw = await tools["relay_deploy"]!.handler({ app: "myapp" });
    const result = parseResult(raw);

    expect(result).toEqual(blockedResult);
    // recordDeploy must NOT have been called for blocked deploys
    expect(mockRecordDeploy).not.toHaveBeenCalled();
    expect((raw as ToolResult).isError).toBeUndefined();
  });

  it("returns err wrapping when deployApp throws", async () => {
    mockDeployApp.mockRejectedValue(new Error("disk full"));

    const tools = getTools();
    const raw = await tools["relay_deploy"]!.handler({ app: "myapp" });
    const result = parseResult(raw) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk full");
    expect((raw as ToolResult).isError).toBe(true);
    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });

  it("handles non-Error thrown values", async () => {
    mockDeployApp.mockRejectedValue("string error");

    const tools = getTools();
    const raw = await tools["relay_deploy"]!.handler({ app: "myapp" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("string error");
    expect((raw as ToolResult).isError).toBe(true);
  });
});

// ── relay_status ─────────────────────────────────────────────────────────────

describe("relay_status", () => {
  it("returns getAppDetail result when app is specified", async () => {
    const detail = { name: "myapp", config: {}, commit: "abc123", containers: null };
    mockGetAppDetail.mockResolvedValue(detail as never);

    const tools = getTools();
    const raw = await tools["relay_status"]!.handler({ app: "myapp" });
    const result = parseResult(raw);

    expect(result).toEqual(detail);
    expect(mockGetAppDetail).toHaveBeenCalledWith("myapp");
    expect(mockListApps).not.toHaveBeenCalled();
  });

  it("returns listApps result when no app specified", async () => {
    const list = [{ name: "app1", configured: true }];
    mockListApps.mockResolvedValue(list as never);

    const tools = getTools();
    const raw = await tools["relay_status"]!.handler({});
    const result = parseResult(raw) as { apps: unknown };

    expect(result.apps).toEqual(list);
    expect(mockListApps).toHaveBeenCalledOnce();
    expect(mockGetAppDetail).not.toHaveBeenCalled();
  });

  it("returns err when service throws", async () => {
    mockGetAppDetail.mockRejectedValue(new Error("not found"));

    const tools = getTools();
    const raw = await tools["relay_status"]!.handler({ app: "ghost" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("not found");
    expect((raw as ToolResult).isError).toBe(true);
  });
});

// ── relay_rollback ────────────────────────────────────────────────────────────

describe("relay_rollback", () => {
  it("returns ok and calls recordDeploy on success", async () => {
    const rollbackResult = { success: true, commitBefore: "aaa", commitAfter: "bbb" };
    mockRollbackApp.mockResolvedValue(rollbackResult as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);

    const tools = getTools();
    const raw = await tools["relay_rollback"]!.handler({ app: "myapp", to_commit: "HEAD~1" });
    const result = parseResult(raw) as typeof rollbackResult & { message: string };

    expect(result.message).toContain("bbb");
    expect(mockRollbackApp).toHaveBeenCalledWith("myapp", "HEAD~1");
    expect(mockRecordDeploy).toHaveBeenCalledWith("myapp", rollbackResult, "mcp");
    expect((raw as ToolResult).isError).toBeUndefined();
  });

  it("returns err when rollbackApp throws", async () => {
    mockRollbackApp.mockRejectedValue(new Error("rollback failed"));

    const tools = getTools();
    const raw = await tools["relay_rollback"]!.handler({ app: "myapp" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("rollback failed");
    expect((raw as ToolResult).isError).toBe(true);
    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });

  it("COMMIT_REF schema: accepts valid hex SHA (4-40 chars)", () => {
    const tools = getTools();
    const schema = tools["relay_rollback"]!.inputSchema;
    expect(schema?.safeParse({ app: "x", to_commit: "abcd1234" }).success).toBe(true);
    expect(schema?.safeParse({ app: "x", to_commit: "abcdef1234567890abcdef1234567890abcdef12" }).success).toBe(true);
  });

  it("COMMIT_REF schema: accepts HEAD~N pattern", () => {
    const tools = getTools();
    const schema = tools["relay_rollback"]!.inputSchema;
    expect(schema?.safeParse({ app: "x", to_commit: "HEAD~1" }).success).toBe(true);
    expect(schema?.safeParse({ app: "x", to_commit: "HEAD~10" }).success).toBe(true);
    expect(schema?.safeParse({ app: "x", to_commit: "HEAD~100" }).success).toBe(true);
  });

  it("COMMIT_REF schema: rejects invalid commit refs", () => {
    const tools = getTools();
    const schema = tools["relay_rollback"]!.inputSchema;
    // Too short (3 chars)
    expect(schema?.safeParse({ app: "x", to_commit: "abc" }).success).toBe(false);
    // Non-hex characters
    expect(schema?.safeParse({ app: "x", to_commit: "xyz123abc" }).success).toBe(false);
    // Shell injection attempt
    expect(schema?.safeParse({ app: "x", to_commit: "abc123; rm -rf /" }).success).toBe(false);
    // HEAD~N with > 3 digits
    expect(schema?.safeParse({ app: "x", to_commit: "HEAD~1000" }).success).toBe(false);
  });
});

// ── relay_logs ───────────────────────────────────────────────────────────────

describe("relay_logs", () => {
  it("calls fetchLogs and returns result on success", async () => {
    const logsResult = { app: "myapp", lines: 50, logs: "log output" };
    mockFetchLogs.mockResolvedValue(logsResult as never);

    const tools = getTools();
    const raw = await tools["relay_logs"]!.handler({ app: "myapp", lines: 50 });
    const result = parseResult(raw);

    expect(result).toEqual(logsResult);
    expect(mockFetchLogs).toHaveBeenCalledWith("myapp", 50, undefined);
  });

  it("passes service name through to fetchLogs", async () => {
    mockFetchLogs.mockResolvedValue({ app: "myapp", lines: 20, logs: "" } as never);

    const tools = getTools();
    await tools["relay_logs"]!.handler({ app: "myapp", lines: 20, service: "backend" });

    expect(mockFetchLogs).toHaveBeenCalledWith("myapp", 20, "backend");
  });

  it("returns err when fetchLogs throws", async () => {
    mockFetchLogs.mockRejectedValue(new Error("docker error"));

    const tools = getTools();
    const raw = await tools["relay_logs"]!.handler({ app: "myapp" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("docker error");
    expect((raw as ToolResult).isError).toBe(true);
  });

  it("SERVICE_NAME schema: accepts alphanumeric, dash, underscore", () => {
    const tools = getTools();
    const schema = tools["relay_logs"]!.inputSchema;
    expect(schema?.safeParse({ app: "x", service: "backend" }).success).toBe(true);
    expect(schema?.safeParse({ app: "x", service: "my-service_01" }).success).toBe(true);
  });

  it("SERVICE_NAME schema: rejects invalid service names", () => {
    const tools = getTools();
    const schema = tools["relay_logs"]!.inputSchema;
    // Space in service name
    expect(schema?.safeParse({ app: "x", service: "bad service" }).success).toBe(false);
    // Shell metacharacter
    expect(schema?.safeParse({ app: "x", service: "svc;rm" }).success).toBe(false);
  });
});

// ── relay_preflight ──────────────────────────────────────────────────────────

describe("relay_preflight", () => {
  it("returns ok with preflight report on success", async () => {
    const report = { passed: true, checks: [{ name: "compose_file_exists", passed: true, message: "ok", critical: true }] };
    mockRunPreflight.mockResolvedValue(report as never);

    const tools = getTools();
    const raw = await tools["relay_preflight"]!.handler({ app: "myapp" });
    const result = parseResult(raw) as { app: string };

    expect(result.app).toBe("myapp");
    expect(mockRunPreflight).toHaveBeenCalledWith("myapp");
    expect((raw as ToolResult).isError).toBeUndefined();
  });

  it("returns err when runPreflight throws", async () => {
    mockRunPreflight.mockRejectedValue(new Error("app not found"));

    const tools = getTools();
    const raw = await tools["relay_preflight"]!.handler({ app: "ghost" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("app not found");
    expect((raw as ToolResult).isError).toBe(true);
  });
});
