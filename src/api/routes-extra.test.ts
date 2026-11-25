/**
 * Additional HTTP-layer tests for routes.ts covering:
 * - SSE-streaming deploy path (step / done / blocked / error events + recordDeploy side-effect)
 * - Rollback 400-vs-404 mapping (RelayConfigError→404, generic Error→400)
 * - GET /system async metric collection (500 fallbacks, empty-output
 *   fallbacks, per-command timeout wiring, event loop stays free)
 * - GET /deploys listing
 *
 * Env routes and the non-streaming blocked-deploy shape are covered in their
 * own test files; this file focuses on the gaps listed above.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./routes.js";
import { env } from "../config/env.js";
import { RelayConfigError } from "../config/relay.js";
import * as relayMod from "../config/relay.js";
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

// loadRelayConfig defaults to resolving so the existing SSE tests (which never
// configure it) keep exercising the real streaming-deploy mock path; the
// dedicated pre-stream-validation test below overrides it with `...Once`.
vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return {
    ...actual,
    loadRelayConfig: vi.fn().mockResolvedValue({ compose_file: "docker-compose.yml" } as never),
  };
});

vi.mock("../services/history.js", () => ({
  recordDeploy: vi.fn(),
  getHistory: vi.fn(),
}));

// The /system handler runs the free/df pipelines through runShell; only the
// shell entry is stubbed, the rest of the exec module stays real so the
// engine's runExec imports keep resolving.
vi.mock("../deploy/exec.js", async () => {
  const actual = await vi.importActual<typeof import("../deploy/exec.js")>("../deploy/exec.js");
  return { ...actual, runShell: vi.fn() };
});

vi.mock("../services/cpu.js", () => ({
  readCpuUsage: vi.fn(),
}));

import { runShell } from "../deploy/exec.js";
import { readCpuUsage } from "../services/cpu.js";

const mockDeployAppStreaming = vi.mocked(apps.deployAppStreaming);
const mockRollbackApp = vi.mocked(apps.rollbackApp);
const mockRecordDeploy = vi.mocked(historyMod.recordDeploy);
const mockGetHistory = vi.mocked(historyMod.getHistory);
const mockRunShell = vi.mocked(runShell);
const mockReadCpuUsage = vi.mocked(readCpuUsage);
const mockLoadRelayConfig = vi.mocked(relayMod.loadRelayConfig);

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

  it("emits error event (HTTP 200) when deployAppStreaming rejects with RelayConfigError mid-stream", async () => {
    // Contract boundary: a RelayConfigError from the pre-stream config check
    // (see the 404 test below) is a real 404. A RelayConfigError thrown by
    // deployAppStreaming itself once the stream is already open (e.g. the
    // compose file escapes APPS_DIR, discovered mid-deploy) is just another
    // in-stream failure: it stays an SSE `error` event over HTTP 200, same as
    // any other rejection from deployAppStreaming.
    mockDeployAppStreaming.mockRejectedValue(
      new RelayConfigError("compose_file resolves outside the apps directory"),
    );

    const res = await request("/apps/demo/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");

    const text = await res.text();
    const events = parseSseEvents(text);

    const errorEvent = events.find((e) => e.event === "error");
    expect(errorEvent).toBeDefined();
    expect((errorEvent!.data as { message: string }).message).toBe(
      "compose_file resolves outside the apps directory",
    );
    expect(mockDeployAppStreaming).toHaveBeenCalled();
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

  it("returns 404 (not a 200 SSE error event) when the app config is invalid", async () => {
    mockLoadRelayConfig.mockRejectedValueOnce(new RelayConfigError("No .relay.yml found in /apps/ghost"));

    const res = await request("/apps/ghost/deploy?stream=true", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get("Content-Type")).not.toContain("text/event-stream");
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("No .relay.yml");

    // The stream must never have opened: no deploy attempt, no recorded history.
    expect(mockDeployAppStreaming).not.toHaveBeenCalled();
    expect(mockRecordDeploy).not.toHaveBeenCalled();
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

  it("includes phase: after_reset on the 400 body when the service tags the error after_reset", async () => {
    mockRollbackApp.mockRejectedValue(
      Object.assign(new Error("Rebuild failed: boom"), { rollbackPhase: "after_reset" }),
    );

    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Rebuild failed: boom", phase: "after_reset" });
  });

  it("includes phase: before_reset on the 400 body when the service tags the error before_reset", async () => {
    mockRollbackApp.mockRejectedValue(
      Object.assign(new Error("Rollback failed: bad ref"), { rollbackPhase: "before_reset" }),
    );

    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Rollback failed: bad ref", phase: "before_reset" });
  });

  it("carries the phase on a 404 RelayConfigError too, and omits the field when untagged", async () => {
    mockRollbackApp.mockRejectedValueOnce(
      Object.assign(new RelayConfigError("bad config at target"), { rollbackPhase: "after_reset" }),
    );
    const tagged = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(tagged.status).toBe(404);
    expect(await tagged.json()).toEqual({ error: "bad config at target", phase: "after_reset" });

    mockRollbackApp.mockRejectedValueOnce(new Error("plain failure"));
    const untagged = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(untagged.status).toBe(400);
    expect(await untagged.json()).toEqual({ error: "plain failure" });
  });

  // `phase` must precede `error` in the serialised body: a caller that cuts
  // the answer at its read cap still sees which phase failed. Checked on the
  // raw text (not just the parsed object) because JSON key order is part of
  // the contract.
  async function rollbackBodyKeyOrder(rejection: Error, expectedStatus: number) {
    mockRollbackApp.mockRejectedValue(rejection);
    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(expectedStatus);
    const text = await res.text();
    expect(text.startsWith('{"phase"')).toBe(true);
    expect(Object.keys(JSON.parse(text) as Record<string, unknown>)).toEqual(["phase", "error"]);
  }

  it("serialises phase before error on the 400 branch", async () => {
    await rollbackBodyKeyOrder(
      Object.assign(new Error("Rebuild failed: boom"), { rollbackPhase: "after_reset" }),
      400,
    );
  });

  it("serialises phase before error on the 404 branch", async () => {
    await rollbackBodyKeyOrder(
      Object.assign(new RelayConfigError("bad config at target"), { rollbackPhase: "after_reset" }),
      404,
    );
  });

  it("serialises phase before error on the 409 branch", async () => {
    await rollbackBodyKeyOrder(
      Object.assign(
        new apps.DeployConflictError("rollback", { kind: "deploy", target: "myapp", startedAt: "earlier" }),
        { rollbackPhase: "before_reset" },
      ),
      409,
    );
  });

  it("keeps an untagged body free of the phase key and error first", async () => {
    mockRollbackApp.mockRejectedValue(new Error("plain failure"));
    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text.startsWith('{"error"')).toBe(true);
    const body = JSON.parse(text) as Record<string, unknown>;
    expect("phase" in body).toBe(false);
    expect(Object.keys(body)).toEqual(["error"]);
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

  it("returns { result } with blocked:true and skips recordDeploy when rollback is preflight-blocked", async () => {
    // Task 1074feb5: same wrapping as a blocked deploy (200, { result:
    // {..., blocked: true, preflight} }) — a loud, structured rejection,
    // not the flat {error} shape a thrown Error still produces above.
    const blockedResult = {
      success: false,
      blocked: true,
      preflight: {
        passed: false,
        checks: [
          { name: "compose_bind_mount_sources_exist", passed: false, message: "missing source", critical: true },
        ],
      },
      commitBefore: "old",
      commitAfter: "new",
    };
    mockRollbackApp.mockResolvedValue(blockedResult as never);

    const res = await request("/apps/myapp/rollback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ to_commit: "abc1234" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: typeof blockedResult };
    expect(body.result).toEqual(blockedResult);
    expect(mockRecordDeploy).not.toHaveBeenCalled();
  });
});

// ── GET /system — async metric collection ────────────────────────────────────

type ExecStub = { stdout: string; stderr: string; exitCode: number; killReason?: "timeout" | "maxbuffer" };

function execOk(stdout: string): ExecStub {
  return { stdout, stderr: "", exitCode: 0 };
}

const MEM_OK = execOk("1024 4096");
const DISK_OK = execOk("50G 200G 25%");

describe("GET /api/system", () => {
  it("returns 500 with error message when a command exits non-zero", async () => {
    mockRunShell.mockResolvedValue({ stdout: "", stderr: "free: not found", exitCode: 127 });

    const res = await request("/system");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to collect system metrics");
  });

  it("returns 500 when only the disk command exits non-zero", async () => {
    mockRunShell
      .mockResolvedValueOnce(MEM_OK)
      .mockResolvedValueOnce({ stdout: "", stderr: "df: /: cannot read", exitCode: 1 });

    const res = await request("/system");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to collect system metrics");
  });

  it("returns 500 when the memory command times out and passes the 5 s timeout to both commands", async () => {
    mockRunShell
      .mockResolvedValueOnce({ stdout: "", stderr: "", exitCode: 1, killReason: "timeout" })
      .mockResolvedValueOnce(DISK_OK);

    const res = await request("/system");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to collect system metrics");
    expect(mockRunShell).toHaveBeenCalledWith(
      expect.stringContaining("free"), process.cwd(), { timeoutMs: 5_000 },
    );
    expect(mockRunShell).toHaveBeenCalledWith(
      expect.stringContaining("df"), process.cwd(), { timeoutMs: 5_000 },
    );
  });

  it("returns 500 when a measurement rejects unexpectedly", async () => {
    mockRunShell.mockRejectedValue(new Error("spawn /bin/sh ENOENT"));

    const res = await request("/system");

    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("Failed to collect system metrics");
  });

  it("returns 200 with system metrics on success", async () => {
    mockReadCpuUsage.mockResolvedValueOnce(37.5);
    mockRunShell
      .mockResolvedValueOnce(MEM_OK)  // mem used total
      .mockResolvedValueOnce(DISK_OK); // disk used total percent

    const res = await request("/system");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      cpu: { usage: number };
      memory: { usedMb: number; totalMb: number };
      disk: { used: string; total: string; percent: string };
    };
    expect(body.cpu.usage).toBe(37.5);
    expect(body.memory.usedMb).toBe(1024);
    expect(body.memory.totalMb).toBe(4096);
    expect(body.disk.used).toBe("50G");
    expect(body.disk.percent).toBe("25%");
  });

  it("falls back to 0 and \"?\" when both commands print nothing", async () => {
    mockReadCpuUsage.mockResolvedValueOnce(0);
    mockRunShell.mockResolvedValue(execOk(""));

    const res = await request("/system");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memory: { usedMb: number; totalMb: number };
      disk: { used: string; total: string; percent: string };
    };
    expect(body.memory.usedMb).toBe(0);
    expect(body.memory.totalMb).toBe(0);
    expect(body.disk.used).toBe("?");
    expect(body.disk.total).toBe("?");
    expect(body.disk.percent).toBe("?");
  });

  it("falls back per field when a command prints only part of its output", async () => {
    mockReadCpuUsage.mockResolvedValueOnce(0);
    mockRunShell
      .mockResolvedValueOnce(execOk("1024"))
      .mockResolvedValueOnce(execOk("50G 200G"));

    const res = await request("/system");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      memory: { usedMb: number; totalMb: number };
      disk: { used: string; total: string; percent: string };
    };
    expect(body.memory.usedMb).toBe(1024);
    expect(body.memory.totalMb).toBe(0);
    expect(body.disk.used).toBe("50G");
    expect(body.disk.total).toBe("200G");
    expect(body.disk.percent).toBe("?");
  });

  it("runs both shell measurements in parallel", async () => {
    const pending: Array<(r: ExecStub) => void> = [];
    mockRunShell.mockImplementation(() => new Promise<ExecStub>((resolve) => pending.push(resolve)));
    mockReadCpuUsage.mockResolvedValue(0);

    const systemPromise = request("/system");
    // Both measurements are in flight at the same time; neither can start
    // before the other returns when the handler awaits them sequentially.
    await vi.waitFor(() => expect(pending).toHaveLength(2));
    pending[0](MEM_OK);
    pending[1](DISK_OK);

    const res = await systemPromise;
    expect(res.status).toBe(200);
  });

  it("does not block the event loop: /health is served while /system waits on a measurement", async () => {
    const settled: string[] = [];
    let releaseMem: (r: ExecStub) => void = () => {};
    mockRunShell.mockImplementation((cmd) =>
      cmd.includes("free")
        ? new Promise<ExecStub>((resolve) => { releaseMem = resolve; })
        : Promise.resolve(DISK_OK));
    mockReadCpuUsage.mockResolvedValue(0);

    const systemPromise = Promise.resolve(request("/system")).then((res) => {
      settled.push("system");
      return res;
    });
    const healthRes = await Promise.resolve(request("/health")).then((res) => {
      settled.push("health");
      return res;
    });

    expect(healthRes.status).toBe(200);
    // A synchronous measurement would have run to completion (or failed)
    // before the event loop could serve /health.
    expect(settled).toEqual(["health"]);

    releaseMem(MEM_OK);
    const systemRes = await systemPromise;
    expect(systemRes.status).toBe(200);
    expect(settled).toEqual(["health", "system"]);
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

// ── GET /health (/api/health) ────────────────────────────────────────────────

describe("GET /api/health", () => {
  it("includes revision when RELAY_REVISION is set alongside status, version, and uptime", async () => {
    const prev = process.env.RELAY_REVISION;
    process.env.RELAY_REVISION = "89b3f8b920be3ae58617395fddb4d73fe5138f72";
    try {
      const res = await request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        status: string;
        version: string;
        revision: string;
        uptime: number;
      };
      expect(body.status).toBe("ok");
      expect(typeof body.version).toBe("string");
      expect(body.revision).toBe("89b3f8b920be3ae58617395fddb4d73fe5138f72");
      expect(typeof body.uptime).toBe("number");
    } finally {
      if (prev === undefined) delete process.env.RELAY_REVISION;
      else process.env.RELAY_REVISION = prev;
    }
  });

  it("defaults revision to \"unknown\" when RELAY_REVISION is absent", async () => {
    const prev = process.env.RELAY_REVISION;
    delete process.env.RELAY_REVISION;
    try {
      const res = await request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { revision: string };
      expect(body.revision).toBe("unknown");
    } finally {
      if (prev === undefined) delete process.env.RELAY_REVISION;
      else process.env.RELAY_REVISION = prev;
    }
  });

  it("defaults revision to \"unknown\" when RELAY_REVISION is empty or whitespace", async () => {
    const prev = process.env.RELAY_REVISION;
    process.env.RELAY_REVISION = "  \t ";
    try {
      const res = await request("/health");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { revision: string };
      expect(body.revision).toBe("unknown");
    } finally {
      if (prev === undefined) delete process.env.RELAY_REVISION;
      else process.env.RELAY_REVISION = prev;
    }
  });
});
