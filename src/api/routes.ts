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

// ── GET /api/system — host CPU/RAM/Disk metrics ────────────────────────────
api.get("/system", async (c) => {
  const { execSync } = await import("node:child_process");
  try {
    const cpu = execSync("top -bn1 | grep 'Cpu(s)' | awk '{print $2}'", { timeout: 5000 }).toString().trim();
    const mem = execSync("free -m | awk '/Mem:/{printf \"%d %d\", $3, $2}'", { timeout: 5000 }).toString().trim().split(" ");
    const disk = execSync("df -h / | awk 'NR==2{printf \"%s %s %s\", $3, $2, $5}'", { timeout: 5000 }).toString().trim().split(" ");

    return c.json({
      cpu: { usage: parseFloat(cpu) || 0 },
      memory: { usedMb: parseInt(mem[0]) || 0, totalMb: parseInt(mem[1]) || 0 },
      disk: { used: disk[0] || "?", total: disk[1] || "?", percent: disk[2] || "?" },
      uptime: process.uptime(),
    });
  } catch {
    return c.json({ error: "Failed to collect system metrics" }, 500);
  }
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
  const stream = c.req.query("stream") === "true";

  // SSE streaming mode
  if (stream) {
    try {
      return new Response(
        new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            function send(event: string, data: unknown) {
              controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
            }

            try {
              const result = await apps.deployAppStreaming(
                name,
                { branch: body.branch, force: body.force },
                (step) => send("step", step),
              );

              if ("blocked" in result && result.blocked) {
                send("blocked", result.preflight);
              } else {
                await recordDeploy(name, result, "api");
                send("done", result);
              }
            } catch (err: any) {
              send("error", { message: err.message });
            }

            controller.close();
          },
        }),
        {
          headers: {
            "Content-Type": "text/event-stream",
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
          },
        },
      );
    } catch (err) {
      if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
      throw err;
    }
  }

  // Regular mode (existing behavior)
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
