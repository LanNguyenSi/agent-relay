import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "./routes.js";
import { env } from "../config/env.js";
import * as selfUpdate from "../deploy/self-update.js";
import {
  acquireOperationLock,
  resetOperationLockForTests,
} from "../deploy/engine.js";

const AUTH = `Bearer ${env.AUTH_TOKEN}`;
const OLD_SHA = "1111111111111111111111111111111111111111";
const NEW_SHA = "2222222222222222222222222222222222222222";
const DIGEST = "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return api.fetch(new Request(`http://test${path}`, { ...init, headers }));
}

describe("POST /api/self-update and GET /api/self-update routes", () => {
  beforeEach(() => {
    resetOperationLockForTests();
  });

  afterEach(() => {
    resetOperationLockForTests();
    vi.restoreAllMocks();
  });

  it("enforces Bearer token auth on POST /api/self-update and GET /api/self-update (401 without valid token)", async () => {
    const noAuthPost = await api.fetch(
      new Request("http://test/self-update", { method: "POST" }),
    );
    expect(noAuthPost.status).toBe(401);

    const badAuthPost = await api.fetch(
      new Request("http://test/self-update", {
        method: "POST",
        headers: { Authorization: "Bearer wrong-token" },
      }),
    );
    expect(badAuthPost.status).toBe(401);

    const noAuthGet = await api.fetch(
      new Request("http://test/self-update", { method: "GET" }),
    );
    expect(noAuthGet.status).toBe(401);
  });

  it("returns 202 with targetImage, digest, previousRevision, and targetRevision and invokes launchHelper after responding", async () => {
    const launchHelper = vi.fn().mockResolvedValue(undefined);
    const prepareSpy = vi.spyOn(selfUpdate, "prepareSelfUpdate").mockResolvedValue({
      status: "accepted",
      tag: "latest",
      targetImage: "ghcr.io/lannguyensi/agent-relay:latest",
      digest: DIGEST,
      previousRevision: OLD_SHA,
      targetRevision: NEW_SHA,
      recovery: selfUpdate.SELF_UPDATE_RECOVERY_GUIDANCE,
      launchHelper,
    });

    const res = await request("/self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(202);
    expect(launchHelper).not.toHaveBeenCalled();
    expect(prepareSpy).toHaveBeenCalledWith({ tag: undefined });
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      status: "accepted",
      tag: "latest",
      targetImage: "ghcr.io/lannguyensi/agent-relay:latest",
      digest: DIGEST,
      previousRevision: OLD_SHA,
      targetRevision: NEW_SHA,
      recovery: selfUpdate.SELF_UPDATE_RECOVERY_GUIDANCE,
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(launchHelper).toHaveBeenCalledTimes(1);
  });

  it("forwards only the tag from the request body to prepareSelfUpdate", async () => {
    const prepareSpy = vi.spyOn(selfUpdate, "prepareSelfUpdate").mockResolvedValue({
      status: "accepted",
      tag: "latest",
      targetImage: "ghcr.io/lannguyensi/agent-relay:latest",
      digest: DIGEST,
      previousRevision: OLD_SHA,
      targetRevision: NEW_SHA,
      recovery: selfUpdate.SELF_UPDATE_RECOVERY_GUIDANCE,
      launchHelper: vi.fn().mockResolvedValue(undefined),
    });

    const res = await request("/self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tag: "latest",
        candidates: ["--privileged"],
        postSpawnLockMs: 0,
        image: "evil/image",
      }),
    });
    expect(res.status).toBe(202);
    expect(prepareSpy.mock.calls[0]?.[0]).toStrictEqual({ tag: "latest" });
  });

  it("returns 400 when body is invalid JSON, not an object, or has a disallowed tag", async () => {
    const badJsonRes = await request("/self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(badJsonRes.status).toBe(400);

    const arrayBodyRes = await request("/self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(["latest"]),
    });
    expect(arrayBodyRes.status).toBe(400);

    const badTagRes = await request("/self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "latest; rm -rf /" }),
    });
    expect(badTagRes.status).toBe(400);
    expect(await badTagRes.json()).toMatchObject({
      kind: "invalid_tag",
    });
  });

  it("returns 422 when prepareSelfUpdate refuses due to build-based compose or missing labels", async () => {
    vi.spyOn(selfUpdate, "prepareSelfUpdate").mockRejectedValue(
      new selfUpdate.SelfUpdateRefusedError(
        "Relay service 'relay' uses a build-based compose configuration ('build:' is set).",
      ),
    );

    const res = await request("/self-update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tag: "latest" }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      kind: "unsupported_compose",
      error: expect.stringContaining("build-based compose configuration"),
    });
  });

  it("returns 409 on POST /api/self-update when a deploy or rollback is already active", async () => {
    const release = acquireOperationLock("deploy", "demo-app");
    try {
      const res = await request("/self-update", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(409);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        kind: "relay_busy",
        error: expect.stringContaining("Cannot start self-update: deploy (demo-app) is already in progress"),
        activeOperation: { kind: "deploy", target: "demo-app" },
      });
    } finally {
      release();
    }
  });

  it("returns 409 on POST /api/apps/:name/deploy (plain and stream) and POST /api/apps/:name/rollback when self-update holds the lock", async () => {
    const release = acquireOperationLock("self-update", "ghcr.io/lannguyensi/agent-relay:latest");
    try {
      const deployPlainRes = await request("/apps/demo/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(deployPlainRes.status).toBe(409);
      expect(await deployPlainRes.json()).toMatchObject({
        error: expect.stringContaining("self-update"),
      });

      const deployStreamRes = await request("/apps/demo/deploy?stream=true", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(deployStreamRes.status).toBe(409);
      expect(await deployStreamRes.json()).toMatchObject({
        error: expect.stringContaining("self-update"),
      });

      const rollbackRes = await request("/apps/demo/rollback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(rollbackRes.status).toBe(409);
      expect(await rollbackRes.json()).toMatchObject({
        error: expect.stringContaining("self-update"),
      });
    } finally {
      release();
    }
  });
});
