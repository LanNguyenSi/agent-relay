/**
 * Additional HTTP-layer tests for routes.ts covering:
 * - SSE-streaming deploy path (step / done / blocked / error events + recordDeploy side-effect)
 * - Rollback 400-vs-404 mapping (RelayConfigError→404, generic Error→400)
 * - GET /system execSync 500 fallback
 * - GET /deploys listing
 *
 * Env routes and the non-streaming blocked-deploy shape are covered in their
 * own test files; this file focuses on the gaps listed above.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./routes.js";
import { env } from "../config/env.js";
import { RelayConfigError } from "../config/relay.js";
import * as apps from "../services/apps.js";
import * as historyMod from "../services/history.js";

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock("../services/apps.js", async () => {
  const actual = await vi.importActual<typeof import("../services/apps.js")>("../services/apps.js");
  return {
    ...actual,
    deployApp: vi.fn(),
    deployAppStreaming: vi.fn(),
    rollbackApp: vi.fn(),
    listApps: vi.fn(),
    getAppDetail: vi.fn(),
    fetchLogs: vi.fn(),
    runPreflight: vi.fn(),
  };
});

vi.mock("../services/history.js", () => ({
  recordDeploy: vi.fn(),
  getHistory: vi.fn(),
}));

// child_process execSync is imported dynamically inside the /system handler.
vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

import { execSync } from "node:child_process";

const mockDeployAppStreaming = vi.mocked(apps.deployAppStreaming);
const mockRollbackApp = vi.mocked(apps.rollbackApp);
const mockRecordDeploy = vi.mocked(historyMod.recordDeploy);
const mockGetHistory = vi.mocked(historyMod.getHistory);
const mockExecSync = vi.mocked(execSync);

const AUTH = `Bearer ${env.AUTH_TOKEN}`;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return api.fetch(new Request(`http://test${path}`, { ...init, headers }));
}

afterEach(() => {
  vi.clearAllMocks();
});

// ── SSE streaming deploy ─────────────────────────────────────────────────────

/**
 * Parse SSE body text into an array of { event, data } pairs.
 */
function parseSseEvents(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const lines = block.split("\n");
      const event = lines.find((l) => l.startsWith("event:"))?.slice(7).trim() ?? "";
      const dataLine = lines.find((l) => l.startsWith("data:"))?.slice(6).trim() ?? "{}";
      return { event, data: JSON.parse(dataLine) };
    });
}

describe("POST /api/apps/:name/deploy?stream=true — SSE streaming", () => {
  it("emits step and done events and calls recordDeploy on success", async () => {
    const successResult = {
      success: true,
      commitBefore: "aaa",
      commitAfter: "bbb",
      durationMs: 100,
      steps: [],
    };
    mockDeployAppStreaming.mockImplementation(async (_name, _opts, onStep) => {
      onStep?.({ name: "git pull", status: "success", output: "", durationMs: 10 } as never);
      onStep?.({ name: "compose build", status: "success", output: "", durationMs: 20 } as never);
      return successResult;
    });
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);

    const res = await request("/apps/demo/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    const text = await res.text();
    const events = parseSseEvents(text);

    const stepEvents = events.filter((e) => e.event === "step");
    expect(stepEvents).toHaveLength(2);
    expect((stepEvents[0]!.data as { name: string }).name).toBe("git pull");

    const doneEvent = events.find((e) => e.event === "done");
    expect(doneEvent).toBeDefined();
    expect((doneEvent!.data as typeof successResult).commitAfter).toBe("bbb");

    expect(mockRecordDeploy).toHaveBeenCalledOnce();
    expect(mockRecordDeploy).toHaveBeenCalledWith("demo", successResult, "api");
  });

  it("emits blocked event and does NOT call recordDeploy when deploy is blocked", async () => {
    const preflight = { ok: false, checks: [{ name: "compose_file_exists", ok: false }] };
    const blockedResult = {
      success: false,
      blocked: true,
      preflight,
      durationMs: 0,
      commitBefore: "abc",
      commitAfter: "abc",
      steps: [],
    };
    mockDeployAppStreaming.mockResolvedValue(blockedResult as never);

    const res = await request("/apps/demo/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const text = await res.text();
    const events = parseSseEvents(text);

    const blockedEvent = events.find((e) => e.event === "blocked");
    expect(blockedEvent).toBeDefined();
    expect(blockedEvent!.data).toEqual(preflight);

    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });

  it("emits error event when deployAppStreaming throws", async () => {
    mockDeployAppStreaming.mockRejectedValue(new Error("deploy exploded"));

    const res = await request("/apps/demo/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    const text = await res.text();
    const events = parseSseEvents(text);

    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toBe("deploy exploded");
    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });

  it("sets SSE headers (Content-Type, Cache-Control, Connection)", async () => {
    mockDeployAppStreaming.mockResolvedValue({
      success: true,
      commitBefore: "a",
      commitAfter: "b",
      durationMs: 0,
      steps: [],
    } as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-1" } as never);

    const res = await request("/apps/demo/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
  });
});

// ── Rollback 400-vs-404 mapping ──────────────────────────────────────────────

describe("POST /api/apps/:name/rollback — error mapping", () => {
  it("returns 404 when app not found (RelayConfigError)", async () => {
    mockRollbackApp.mockRejectedValue(new RelayConfigError("No .relay.yml found in /apps/ghost"));

    const res = await request("/apps/ghost/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("No .relay.yml");
  });

  it("returns 400 for other errors (e.g. invalid commit ref)", async () => {
    mockRollbackApp.mockRejectedValue(new Error("Rollback failed: bad commit"));

    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_commit: "HEAD~1" }),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Rollback failed");
  });

  it("calls recordDeploy and returns 200 on success", async () => {
    const rollbackResult = { success: true, commitBefore: "old", commitAfter: "new" };
    mockRollbackApp.mockResolvedValue(rollbackResult as never);
    mockRecordDeploy.mockResolvedValue({ id: "d-5" } as never);

    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_commit: "abc1234" }),
    });

    expect(res.status).toBe(200);
    expect(mockRecordDeploy).toHaveBeenCalledWith("myapp", rollbackResult, "api");
  });
});

// ── GET /system — execSync 500 fallback ──────────────────────────────────────

describe("GET /api/system", () => {
  it("returns 500 with error message when execSync throws", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("command not found");
    });

    const res = await request("/system");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to collect system metrics");
  });

  it("returns 200 with system metrics on success", async () => {
    mockExecSync
      .mockReturnValueOnce(Buffer.from("2.5"))          // cpu usage
      .mockReturnValueOnce(Buffer.from("1024 4096"))    // mem used total
      .mockReturnValueOnce(Buffer.from("50G 200G 25%")); // disk used total percent

    const res = await request("/system");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cpu: { usage: number };
      memory: { usedMb: number; totalMb: number };
      disk: { used: string; total: string; percent: string };
    };
    expect(body.cpu.usage).toBe(2.5);
    expect(body.memory.usedMb).toBe(1024);
    expect(body.memory.totalMb).toBe(4096);
    expect(body.disk.used).toBe("50G");
    expect(body.disk.percent).toBe("25%");
  });
});

// ── GET /deploys ─────────────────────────────────────────────────────────────

describe("GET /api/deploys", () => {
  it("returns all deploy records when no app filter", async () => {
    const records = [
      { id: "d-2", app: "app-a", status: "success", commitBefore: "a", commitAfter: "b", durationMs: 1, triggeredBy: "ci", createdAt: "" },
      { id: "d-1", app: "app-b", status: "failed",  commitBefore: "a", commitAfter: "a", durationMs: 0, triggeredBy: "api", createdAt: "" },
    ];
    mockGetHistory.mockResolvedValue(records as never);

    const res = await request("/deploys");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploys: typeof records };
    expect(body.deploys).toHaveLength(2);
    expect(mockGetHistory).toHaveBeenCalledWith(undefined);
  });

  it("passes app query param through to getHistory", async () => {
    mockGetHistory.mockResolvedValue([
      { id: "d-3", app: "myapp", status: "success", commitBefore: "x", commitAfter: "y", durationMs: 5, triggeredBy: "mcp", createdAt: "" },
    ] as never);

    const res = await request("/deploys?app=myapp");

    expect(res.status).toBe(200);
    expect(mockGetHistory).toHaveBeenCalledWith("myapp");
  });

  it("returns 401 without auth token", async () => {
    const res = await api.fetch(new Request("http://test/deploys"));
    expect(res.status).toBe(401);
  });
});
