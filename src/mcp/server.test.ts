/**
 * Tests for the MCP tool handlers in src/mcp/server.ts.
 * Verifies try/catch ok/err wrapping, blocked-deploy branch,
 * COMMIT_REF/SERVICE_NAME regex validation, and recordDeploy side-effect.
 *
 * Everything goes through the SDK's public surface: an in-memory transport
 * pair (InMemoryTransport + Client) driving real tools/list and tools/call
 * requests. The previous revision read the SDK-private `_registeredTools`
 * field and called handlers directly; that bypassed the SDK's own input
 * validation and broke silently across SDK/zod upgrades. Schema accept/reject
 * is now pinned where clients actually see it: in the tools/call round-trip.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

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

type ToolResult = { content?: Array<{ type: string; text: string }>; isError?: boolean };

// Wire a fresh server to a fresh client over the SDK's in-memory transport,
// make one tools/call request, and tear the pair down again. Input-schema
// violations resolve with an `isError: true` result whose text starts with
// "Invalid arguments for tool ..." (see expectInputRejected).
async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await client.close();
  }
}

async function listToolNames(): Promise<string[]> {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);
  try {
    const { tools } = await client.listTools();
    return tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}

function parseResult(raw: ToolResult): unknown {
  const block = raw.content?.[0] as { type: string; text: string } | undefined;
  return JSON.parse(block!.text);
}

function resultText(raw: ToolResult): string {
  const block = raw.content?.[0] as { type: string; text: string } | undefined;
  return block!.text;
}

// The SDK answers schema-invalid tool arguments with an isError result whose
// text carries "Input validation error: Invalid arguments for tool <name>:
// <zod message> at <path>" - it does not reject the request.
async function expectInputRejected(
  name: string,
  args: Record<string, unknown>,
): Promise<string> {
  const raw = await callTool(name, args);
  expect(raw.isError).toBe(true);
  const text = resultText(raw);
  expect(text).toContain(`Invalid arguments for tool ${name}`);
  return text;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ── tools/list ───────────────────────────────────────────────────────────────

describe("tools/list", () => {
  it("publishes the five relay tools", async () => {
    expect(await listToolNames()).toEqual([
      "relay_deploy",
      "relay_logs",
      "relay_preflight",
      "relay_rollback",
      "relay_status",
    ]);
  });
});

// ── relay_deploy ─────────────────────────────────────────────────────────────

describe("relay_deploy", () => {
  it("returns ok result and calls recordDeploy on success", async () => {
    const successResult = { success: true, commitBefore: "aaa", commitAfter: "bbb", durationMs: 10, steps: [] };
    mockDeployApp.mockResolvedValue(successResult as never);
    const fakeRecord = { id: "d-1" };
    mockRecordDeploy.mockResolvedValue(fakeRecord as never);

    const raw = await callTool("relay_deploy", { app: "myapp", branch: "main" });
    const result = parseResult(raw);

    expect(result).toEqual(successResult);
    expect(mockRecordDeploy).toHaveBeenCalledOnce();
    expect(mockRecordDeploy).toHaveBeenCalledWith("myapp", successResult, "mcp");
    expect(raw.isError).toBeUndefined();
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

    const raw = await callTool("relay_deploy", { app: "myapp" });
    const result = parseResult(raw);

    expect(result).toEqual(blockedResult);
    // recordDeploy must NOT have been called for blocked deploys
    expect(mockRecordDeploy).not.toHaveBeenCalled();
    expect(raw.isError).toBeUndefined();
  });

  it("returns err wrapping when deployApp throws", async () => {
    mockDeployApp.mockRejectedValue(new Error("disk full"));

    const raw = await callTool("relay_deploy", { app: "myapp" });
    const result = parseResult(raw) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toBe("disk full");
    expect(raw.isError).toBe(true);
    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });

  it("handles non-Error thrown values", async () => {
    mockDeployApp.mockRejectedValue("string error");

    const raw = await callTool("relay_deploy", { app: "myapp" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("string error");
    expect(raw.isError).toBe(true);
  });
});

// ── relay_status ─────────────────────────────────────────────────────────────

describe("relay_status", () => {
  it("returns getAppDetail result when app is specified", async () => {
    const detail = { name: "myapp", config: {}, commit: "abc123", containers: null };
    mockGetAppDetail.mockResolvedValue(detail as never);

    const raw = await callTool("relay_status", { app: "myapp" });
    const result = parseResult(raw);

    expect(result).toEqual(detail);
    expect(mockGetAppDetail).toHaveBeenCalledWith("myapp");
    expect(mockListApps).not.toHaveBeenCalled();
  });

  it("returns listApps result when no app specified", async () => {
    const list = [{ name: "app1", configured: true }];
    mockListApps.mockResolvedValue(list as never);

    const raw = await callTool("relay_status", {});
    const result = parseResult(raw) as { apps: unknown };

    expect(result.apps).toEqual(list);
    expect(mockListApps).toHaveBeenCalledOnce();
    expect(mockGetAppDetail).not.toHaveBeenCalled();
  });

  it("strips unknown argument keys instead of rejecting (schema is non-strict)", async () => {
    const detail = { name: "myapp", config: {}, commit: "abc123", containers: null };
    mockGetAppDetail.mockResolvedValue(detail as never);

    // Pins the parse semantics behind the tools/list metadata: object schemas
    // strip unknown keys, so clients sending extra fields still succeed and
    // the handler only ever sees declared fields.
    const raw = await callTool("relay_status", { app: "myapp", bogusKey: 42 });
    const result = parseResult(raw);

    expect(result).toEqual(detail);
    expect(mockGetAppDetail).toHaveBeenCalledWith("myapp");
  });

  it("returns err when service throws", async () => {
    mockGetAppDetail.mockRejectedValue(new Error("not found"));

    const raw = await callTool("relay_status", { app: "ghost" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("not found");
    expect(raw.isError).toBe(true);
  });
});

// ── relay_rollback ────────────────────────────────────────────────────────────

describe("relay_rollback", () => {
  it("returns ok and calls recordDeploy on success", async () => {
    const rollbackResult = { success: true, commitBefore: "aaa", commitAfter: "bbb" };
    mockRollbackApp.mockResolvedValue(rollbackResult as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);

    const raw = await callTool("relay_rollback", { app: "myapp", to_commit: "HEAD~1" });
    const result = parseResult(raw) as typeof rollbackResult & { message: string };

    expect(result.message).toContain("bbb");
    expect(mockRollbackApp).toHaveBeenCalledWith("myapp", "HEAD~1");
    expect(mockRecordDeploy).toHaveBeenCalledWith("myapp", rollbackResult, "mcp");
    expect(raw.isError).toBeUndefined();
  });

  it("returns err when rollbackApp throws", async () => {
    mockRollbackApp.mockRejectedValue(new Error("rollback failed"));

    const raw = await callTool("relay_rollback", { app: "myapp" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("rollback failed");
    expect(raw.isError).toBe(true);
    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });

  it("returns ok result but does NOT call recordDeploy when rollback is blocked by preflight", async () => {
    // A rollback blocked by a critical preflight check must
    // surface the same structured shape relay_deploy already uses for a
    // blocked deploy — not the flat err() message a thrown Error produces.
    const blockedResult = {
      success: false,
      blocked: true,
      preflight: {
        passed: false,
        checks: [
          { name: "compose_bind_mount_sources_exist", passed: false, message: "missing source", critical: true },
        ],
      },
      commitBefore: "aaa",
      commitAfter: "bbb",
    };
    mockRollbackApp.mockResolvedValue(blockedResult as never);

    const raw = await callTool("relay_rollback", { app: "myapp" });
    const result = parseResult(raw);

    expect(result).toEqual(blockedResult);
    expect(mockRecordDeploy).not.toHaveBeenCalled();
    expect(raw.isError).toBeUndefined();
  });

  it("COMMIT_REF schema: accepts valid hex SHA (4-40 chars)", async () => {
    mockRollbackApp.mockResolvedValue({ success: true, commitBefore: "aaa", commitAfter: "bbb" } as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);

    await callTool("relay_rollback", { app: "x", to_commit: "abcd1234" });
    expect(mockRollbackApp).toHaveBeenCalledWith("x", "abcd1234");

    await callTool("relay_rollback", {
      app: "x",
      to_commit: "abcdef1234567890abcdef1234567890abcdef12",
    });
    expect(mockRollbackApp).toHaveBeenCalledWith(
      "x",
      "abcdef1234567890abcdef1234567890abcdef12",
    );
  });

  it("COMMIT_REF schema: accepts HEAD~N pattern", async () => {
    mockRollbackApp.mockResolvedValue({ success: true, commitBefore: "aaa", commitAfter: "bbb" } as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);

    for (const ref of ["HEAD~1", "HEAD~10", "HEAD~100"]) {
      await callTool("relay_rollback", { app: "x", to_commit: ref });
    }
    expect(mockRollbackApp).toHaveBeenNthCalledWith(1, "x", "HEAD~1");
    expect(mockRollbackApp).toHaveBeenNthCalledWith(2, "x", "HEAD~10");
    expect(mockRollbackApp).toHaveBeenNthCalledWith(3, "x", "HEAD~100");
  });

  it("COMMIT_REF schema: rejects invalid commit refs", async () => {
    // Too short (3 chars)
    await expectInputRejected("relay_rollback", { app: "x", to_commit: "abc" });
    // Non-hex characters
    await expectInputRejected("relay_rollback", { app: "x", to_commit: "xyz123abc" });
    // Shell injection attempt
    await expectInputRejected("relay_rollback", {
      app: "x",
      to_commit: "abc123; rm -rf /",
    });
    // HEAD~N with > 3 digits
    await expectInputRejected("relay_rollback", { app: "x", to_commit: "HEAD~1000" });
    expect(mockRollbackApp).not.toHaveBeenCalled();
  });

  it("COMMIT_REF reject message keeps the custom regex text on the wire", async () => {
    const text = await expectInputRejected("relay_rollback", {
      app: "x",
      to_commit: "nope",
    });
    expect(text).toContain("Must be a hex SHA or HEAD~N");
    expect(text).toContain("at to_commit");
  });
});

// ── relay_logs ───────────────────────────────────────────────────────────────

describe("relay_logs", () => {
  it("calls fetchLogs and returns result on success", async () => {
    const logsResult = { app: "myapp", lines: 50, logs: "log output" };
    mockFetchLogs.mockResolvedValue(logsResult as never);

    const raw = await callTool("relay_logs", { app: "myapp", lines: 50 });
    const result = parseResult(raw);

    expect(result).toEqual(logsResult);
    expect(mockFetchLogs).toHaveBeenCalledWith("myapp", 50, undefined);
  });

  it("passes service name through to fetchLogs", async () => {
    mockFetchLogs.mockResolvedValue({ app: "myapp", lines: 20, logs: "" } as never);

    await callTool("relay_logs", { app: "myapp", lines: 20, service: "backend" });

    expect(mockFetchLogs).toHaveBeenCalledWith("myapp", 20, "backend");
  });

  it("returns err when fetchLogs throws", async () => {
    mockFetchLogs.mockRejectedValue(new Error("docker error"));

    const raw = await callTool("relay_logs", { app: "myapp" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("docker error");
    expect(raw.isError).toBe(true);
  });

  it("SERVICE_NAME schema: accepts alphanumeric, dash, underscore", async () => {
    mockFetchLogs.mockResolvedValue({ app: "x", lines: 10, logs: "" } as never);

    await callTool("relay_logs", { app: "x", service: "backend" });
    expect(mockFetchLogs).toHaveBeenNthCalledWith(1, "x", undefined, "backend");

    await callTool("relay_logs", { app: "x", service: "my-service_01" });
    expect(mockFetchLogs).toHaveBeenNthCalledWith(2, "x", undefined, "my-service_01");
  });

  it("SERVICE_NAME schema: rejects invalid service names", async () => {
    // Space in service name
    await expectInputRejected("relay_logs", { app: "x", service: "bad service" });
    // Shell metacharacter
    await expectInputRejected("relay_logs", { app: "x", service: "svc;rm" });
    expect(mockFetchLogs).not.toHaveBeenCalled();
  });

  it("SERVICE_NAME reject message keeps the custom regex text on the wire", async () => {
    const text = await expectInputRejected("relay_logs", {
      app: "x",
      service: "bad service",
    });
    expect(text).toContain("Invalid service name");
    expect(text).toContain("at service");
  });

  it("lines schema: accepts the 1000 upper boundary", async () => {
    mockFetchLogs.mockResolvedValue({ app: "x", lines: 1000, logs: "" } as never);

    await callTool("relay_logs", { app: "x", lines: 1000 });
    expect(mockFetchLogs).toHaveBeenCalledWith("x", 1000, undefined);
  });

  it("lines schema: rejects 1001, one past the upper boundary", async () => {
    await expectInputRejected("relay_logs", { app: "x", lines: 1001 });
    expect(mockFetchLogs).not.toHaveBeenCalled();
  });
});

// ── relay_preflight ──────────────────────────────────────────────────────────

describe("relay_preflight", () => {
  it("returns ok with preflight report on success", async () => {
    const report = { passed: true, checks: [{ name: "compose_file_exists", passed: true, message: "ok", critical: true }] };
    mockRunPreflight.mockResolvedValue(report as never);

    const raw = await callTool("relay_preflight", { app: "myapp" });
    const result = parseResult(raw) as { app: string };

    expect(result.app).toBe("myapp");
    expect(mockRunPreflight).toHaveBeenCalledWith("myapp");
    expect(raw.isError).toBeUndefined();
  });

  it("returns err when runPreflight throws", async () => {
    mockRunPreflight.mockRejectedValue(new Error("app not found"));

    const raw = await callTool("relay_preflight", { app: "ghost" });
    const result = parseResult(raw) as { error: string };

    expect(result.error).toBe("app not found");
    expect(raw.isError).toBe(true);
  });
});
