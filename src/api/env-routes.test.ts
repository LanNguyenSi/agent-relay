/**
 * Integration tests for the /api/apps/:name/env routes. Exercises auth +
 * validation through the full Hono app; the service-layer contract is
 * covered separately in `src/services/env.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { api } from "./routes.js";
import { env } from "../config/env.js";

const BASE = env.APPS_DIR;
const APP = "routes-demo";
const AUTH = `Bearer ${env.AUTH_TOKEN}`;

function request(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (!headers.has("Authorization")) headers.set("Authorization", AUTH);
  return api.fetch(new Request(`http://test${path}`, { ...init, headers }));
}

describe("/api/apps/:name/env", () => {
  beforeEach(async () => {
    await mkdir(BASE, { recursive: true });
    await rm(resolve(BASE, APP), { recursive: true, force: true });
    await mkdir(resolve(BASE, APP));
  });
  afterEach(async () => {
    await rm(resolve(BASE, APP), { recursive: true, force: true });
  });

  it("rejects requests without a bearer token", async () => {
    const res = await api.fetch(new Request(`http://test/apps/${APP}/env`));
    expect(res.status).toBe(401);
  });

  it("GET returns [] when no .env exists", async () => {
    const res = await request(`/apps/${APP}/env`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entries: [] });
  });

  it("PUT writes and GET reads back", async () => {
    const put = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          { key: "A", value: "1" },
          { key: "DB_PASSWORD", value: "pw with space" },
        ],
      }),
    });
    expect(put.status).toBe(200);

    const get = await request(`/apps/${APP}/env`);
    expect(await get.json()).toEqual({
      entries: [
        { key: "A", value: "1" },
        { key: "DB_PASSWORD", value: "pw with space" },
      ],
    });
  });

  it("PUT rejects a non-array body", async () => {
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: "oops" }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects duplicate keys", async () => {
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        entries: [
          { key: "A", value: "1" },
          { key: "A", value: "2" },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/Duplicate/);
  });

  it("PUT rejects non-string key/value", async () => {
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "A", value: 5 }] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects an empty key", async () => {
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "", value: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects a key exceeding 128 chars", async () => {
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "A".repeat(129), value: "x" }] }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects more than 500 entries", async () => {
    const entries = Array.from({ length: 501 }, (_, i) => ({
      key: `K${i}`,
      value: "x",
    }));
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    expect(res.status).toBe(400);
  });

  it("PUT rejects values exceeding the 32 KiB cap", async () => {
    const big = "x".repeat(32_768 + 1);
    const res = await request(`/apps/${APP}/env`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries: [{ key: "A", value: big }] }),
    });
    expect(res.status).toBe(400);
  });
});
