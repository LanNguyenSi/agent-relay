/**
 * Caller-supplied deploy id (X-Deploy-Id header / `deployId` body field) on the
 * deploy and rollback endpoints. These tests use the REAL history service on a
 * temp APPS_DIR so they pin what is persisted and what GET /api/apps/:name
 * returns in `recentDeploys`, not just what the route passes along.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";

vi.mock("../config/relay.js", async () => {
  const actual = await vi.importActual<typeof import("../config/relay.js")>("../config/relay.js");
  return {
    ...actual,
    loadRelayConfig: vi.fn().mockResolvedValue({ compose_file: "docker-compose.yml" } as never),
  };
});

const originalAppsDir = process.env.APPS_DIR;
let tmpDir: string;

type Api = typeof import("./routes.js").api;
type Apps = typeof import("../services/apps.js");
let api: Api;
let apps: Apps;
let authHeader: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(resolve(tmpdir(), "agent-relay-deployid-"));
  process.env.APPS_DIR = tmpDir;
  vi.resetModules();
  ({ api } = await import("./routes.js"));
  apps = await import("../services/apps.js");
  const { env } = await import("../config/env.js");
  authHeader = `Bearer ${env.AUTH_TOKEN}`;
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.env.APPS_DIR = originalAppsDir;
  await rm(tmpDir, { recursive: true, force: true });
});

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return api.fetch(
    new Request(`http://test${path}`, {
      method: "POST",
      headers: { Authorization: authHeader, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

async function storedHistory(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(join(tmpDir, ".relay-history.json"), "utf-8"));
}

const okResult = { success: true, commitBefore: "aaa", commitAfter: "bbb", durationMs: 5, steps: [] };

function mockDeploy() {
  const deploy = vi.spyOn(apps, "deployApp").mockResolvedValue(okResult as never);
  const streaming = vi.spyOn(apps, "deployAppStreaming").mockResolvedValue(okResult as never);
  vi.spyOn(apps, "safeAppDir").mockResolvedValue(tmpDir);
  const rollback = vi.spyOn(apps, "rollbackApp").mockResolvedValue({
    success: true,
    commitBefore: "bbb",
    commitAfter: "aaa",
  } as never);
  return { deploy, streaming, rollback };
}

describe("plain deploy with a deploy id", () => {
  it("stores a header id in the record and returns it in recentDeploys", async () => {
    mockDeploy();
    const res = await post("/apps/demo/deploy", {}, { "X-Deploy-Id": "panel-123:abc" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deploy: { deployId?: string } };
    expect(body.deploy.deployId).toBe("panel-123:abc");
    expect((await storedHistory())[0]!.deployId).toBe("panel-123:abc");

    vi.spyOn(apps, "getAppDetail").mockResolvedValue({ name: "demo" } as never);
    const detail = await api.fetch(
      new Request("http://test/apps/demo", { headers: { Authorization: authHeader } }),
    );
    const detailBody = (await detail.json()) as { app: { recentDeploys: Array<{ deployId?: string }> } };
    expect(detailBody.app.recentDeploys[0]!.deployId).toBe("panel-123:abc");
  });

  it("accepts the id in the body and accepts a matching header and body id", async () => {
    mockDeploy();
    const a = await post("/apps/demo/deploy", { deployId: "body-id_1" });
    expect(((await a.json()) as { deploy: { deployId: string } }).deploy.deployId).toBe("body-id_1");
    const b = await post("/apps/demo/deploy", { deployId: "same.id" }, { "X-Deploy-Id": "same.id" });
    expect(((await b.json()) as { deploy: { deployId: string } }).deploy.deployId).toBe("same.id");
  });

  it("keeps records without the field when no id is sent", async () => {
    mockDeploy();
    const res = await post("/apps/demo/deploy", {});
    const body = (await res.json()) as { deploy: Record<string, unknown> };
    expect("deployId" in body.deploy).toBe(false);
    expect("deployId" in (await storedHistory())[0]!).toBe(false);
  });

  it.each([
    ["too long", "a".repeat(129)],
    ["bad charset", "bad id!"],
    ["empty", ""],
  ])("rejects an invalid header id (%s) with 400 and deploys nothing", async (_label, id) => {
    const { deploy } = mockDeploy();
    const res = await post("/apps/demo/deploy", {}, { "X-Deploy-Id": id });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/X-Deploy-Id/);
    expect(deploy).not.toHaveBeenCalled();
  });

  it("accepts a 128-char id (boundary)", async () => {
    mockDeploy();
    const res = await post("/apps/demo/deploy", {}, { "X-Deploy-Id": "a".repeat(128) });
    expect(res.status).toBe(200);
  });

  it("rejects a non-string or invalid body id with 400", async () => {
    const { deploy } = mockDeploy();
    for (const bad of [123, { x: 1 }, "has space"]) {
      const res = await post("/apps/demo/deploy", { deployId: bad });
      expect(res.status).toBe(400);
    }
    expect(deploy).not.toHaveBeenCalled();
  });

  it("rejects differing header and body ids with 400", async () => {
    const { deploy } = mockDeploy();
    const res = await post("/apps/demo/deploy", { deployId: "one" }, { "X-Deploy-Id": "two" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/differ/);
    expect(deploy).not.toHaveBeenCalled();
  });
});

describe("stream deploy with a deploy id", () => {
  it("stores the id when the stream completes", async () => {
    mockDeploy();
    const res = await post("/apps/demo/deploy?stream=true", {}, { "X-Deploy-Id": "stream-1" });
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    await res.text();
    expect((await storedHistory())[0]!.deployId).toBe("stream-1");
  });

  it("stores the body id and leaves records unchanged without an id", async () => {
    mockDeploy();
    await (await post("/apps/demo/deploy?stream=true", { deployId: "stream-body" })).text();
    await (await post("/apps/demo/deploy?stream=true", {})).text();
    const [second, first] = await storedHistory();
    expect(first!.deployId).toBe("stream-body");
    expect("deployId" in second!).toBe(false);
  });

  it("rejects an invalid id with a 400 before opening the stream", async () => {
    const { streaming } = mockDeploy();
    const res = await post("/apps/demo/deploy?stream=true", {}, { "X-Deploy-Id": "bad id" });
    expect(res.status).toBe(400);
    expect(res.headers.get("Content-Type")).toContain("application/json");
    expect(streaming).not.toHaveBeenCalled();
  });
});

describe("rollback with a deploy id", () => {
  it("stores the id in the recorded entry", async () => {
    mockDeploy();
    const res = await post("/apps/demo/rollback", { to_commit: "HEAD~1" }, { "X-Deploy-Id": "rb-1" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { deploy: { deployId: string } }).deploy.deployId).toBe("rb-1");
    expect((await storedHistory())[0]!.deployId).toBe("rb-1");
  });

  it("keeps the record unchanged without an id", async () => {
    mockDeploy();
    const res = await post("/apps/demo/rollback", {});
    const body = (await res.json()) as { deploy: Record<string, unknown> };
    expect("deployId" in body.deploy).toBe(false);
  });

  it("rejects an invalid id with 400 and starts no rollback", async () => {
    const { rollback } = mockDeploy();
    const res = await post("/apps/demo/rollback", { deployId: "no/slash" });
    expect(res.status).toBe(400);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rejects differing header and body ids with 400", async () => {
    const { rollback } = mockDeploy();
    const res = await post("/apps/demo/rollback", { deployId: "a" }, { "X-Deploy-Id": "b" });
    expect(res.status).toBe(400);
    expect(rollback).not.toHaveBeenCalled();
  });
});
