import { Hono } from "hono";
import { env } from "../config/env.js";
import { RelayConfigError } from "../config/relay.js";
import * as apps from "../services/apps.js";
import { recordDeploy, getHistory } from "../services/history.js";

export const api = new Hono();

// ── Auth middleware ─────────────────────────────────────────────────────────
api.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.AUTH_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// ── GET /api/health ─────────────────────────────────────────────────────────
api.get("/health", (c) => {
  return c.json({ status: "ok", version: "0.1.0", uptime: process.uptime() });
});

// ── GET /api/apps ───────────────────────────────────────────────────────────
api.get("/apps", async (c) => {
  return c.json({ apps: await apps.listApps() });
});

// ── GET /api/apps/:name ────────────────────────────────────────────────────
api.get("/apps/:name", async (c) => {
  try {
    const detail = await apps.getAppDetail(c.req.param("name"));
    const recentDeploys = await getHistory(c.req.param("name"));
    return c.json({ app: { ...detail, recentDeploys: recentDeploys.slice(0, 10) } });
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// ── POST /api/apps/:name/deploy ────────────────────────────────────────────
api.post("/apps/:name/deploy", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));

  try {
    const result = await apps.deployApp(name, { branch: body.branch, force: body.force });
    if ("blocked" in result && result.blocked) {
      return c.json(result);
    }
    const record = await recordDeploy(name, result, "api");
    return c.json({ deploy: record, result });
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// ── POST /api/apps/:name/rollback ──────────────────────────────────────────
api.post("/apps/:name/rollback", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));

  try {
    const result = await apps.rollbackApp(name, body.to_commit);
    const record = await recordDeploy(name, result, "api");
    return c.json({ deploy: record, ...result });
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    if (err instanceof Error) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// ── GET /api/apps/:name/logs ───────────────────────────────────────────────
api.get("/apps/:name/logs", async (c) => {
  try {
    const result = await apps.fetchLogs(
      c.req.param("name"),
      c.req.query("lines") ? Number(c.req.query("lines")) : undefined,
      c.req.query("service") || undefined,
    );
    return c.json(result);
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    if (err instanceof Error) return c.json({ error: err.message }, 400);
    throw err;
  }
});

// ── GET /api/apps/:name/preflight ──────────────────────────────────────────
api.get("/apps/:name/preflight", async (c) => {
  try {
    const report = await apps.runPreflight(c.req.param("name"));
    return c.json({ app: c.req.param("name"), ...report });
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

// ── GET /api/deploys ───────────────────────────────────────────────────────
api.get("/deploys", async (c) => {
  const app = c.req.query("app");
  return c.json({ deploys: await getHistory(app || undefined) });
});
