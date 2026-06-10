/**
 * HTTP-layer regression test for the non-streaming deploy response shape.
 * The blocked (preflight-failed) branch used to return a bare
 * DeployBlockedResult while the happy path returns { deploy, result };
 * both are now wrapped under `result` for client consistency.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./routes.js";
import { env } from "../config/env.js";
import * as apps from "../services/apps.js";

const AUTH = `Bearer ${env.AUTH_TOKEN}`;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return api.fetch(new Request(`http://test${path}`, { ...init, headers }));
}

describe("POST /api/apps/:name/deploy — blocked response shape", () => {
  afterEach(() => vi.restoreAllMocks());

  it("wraps a blocked (preflight-failed) deploy under `result`", async () => {
    const blocked = {
      success: false,
      blocked: true,
      preflight: {
        ok: false,
        checks: [{ name: "compose_file_exists", ok: false, critical: true }],
      },
      durationMs: 0,
      commitBefore: "abc123",
      commitAfter: "abc123",
      steps: [],
    };
    vi.spyOn(apps, "deployApp").mockResolvedValue(blocked as never);

    const res = await request("/apps/demo/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // Wrapped under `result`, matching the happy path's { deploy, result }.
    expect(body).toEqual({ result: blocked });
    // No longer a bare DeployBlockedResult at the top level.
    expect("blocked" in body).toBe(false);
  });
});
