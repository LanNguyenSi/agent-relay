import { Hono } from "hono";
import { isAuthorized } from "../config/auth.js";
import { RELAY_VERSION } from "../config/version.js";
import { loadRelayConfig, RelayConfigError } from "../config/relay.js";
import * as apps from "../services/apps.js";
import * as appEnv from "../services/env.js";
import { recordDeploy, getHistory } from "../services/history.js";

export const api = new Hono();

// ── Auth middleware ─────────────────────────────────────────────────────────
api.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!isAuthorized(auth)) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// ── GET /api/health ─────────────────────────────────────────────────────────
api.get("/health", (c) => {
  return c.json({ status: "ok", version: RELAY_VERSION, uptime: process.uptime() });
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
    // Resolve the app config BEFORE opening the SSE stream. Once the stream is
    // open the response headers are already flushed at 200, so a RelayConfigError
    // thrown inside ReadableStream's async `start()` callback can only ever
    // reach the INNER catch below and surface as an SSE `error` event — the
    // outer try/catch that used to wrap `new Response(...)` was unreachable
    // dead code, since nothing in the synchronous part of stream construction
    // throws. Doing the same config resolution `deployAppStreaming` does
    // internally (safeAppDir + loadRelayConfig) up front lets an unknown app /
    // invalid config return the same 404 the non-streaming path returns.
    try {
      const dir = await apps.safeAppDir(name);
      await loadRelayConfig(dir);
    } catch (err) {
      if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
      throw err;
    }

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
          } catch (err) {
            send("error", { message: err instanceof Error ? err.message : String(err) });
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
  }

  // Regular mode (existing behavior)
  try {
    const result = await apps.deployApp(name, { branch: body.branch, force: body.force });
    if ("blocked" in result && result.blocked) {
      // Wrap the blocked result under `result` so the non-streaming response
      // shape matches the happy path ({ deploy, result }). Clients can branch
      // on `body.result.blocked` instead of two divergent top-level shapes.
      return c.json({ result });
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

// ── Env vars (per-app .env) ────────────────────────────────────────────────
//
// No masking here. The relay returns raw values; the panel is the consent
// boundary that decides what users see. A human operator who can call the
// relay directly already has Bearer-token access to the whole VPS.

// Strict upper bounds to keep the relay from being DoS'd by a runaway client.
const ENV_MAX_ENTRIES = 500;
const ENV_MAX_KEY = 128;
const ENV_MAX_VALUE = 32_768;

api.get("/apps/:name/env", async (c) => {
  try {
    const entries = await appEnv.readAppEnv(c.req.param("name"));
    return c.json({ entries });
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    throw err;
  }
});

api.put("/apps/:name/env", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body || !Array.isArray(body.entries)) {
    return c.json({ error: "Body must be { entries: [{ key, value }] }" }, 400);
  }
  const raw = body.entries as unknown[];
  if (raw.length > ENV_MAX_ENTRIES) {
    return c.json({ error: `Too many entries (max ${ENV_MAX_ENTRIES})` }, 400);
  }
  const seen = new Set<string>();
  const entries: appEnv.EnvEntry[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") {
      return c.json({ error: "Each entry must be { key, value }" }, 400);
    }
    const { key, value } = row as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || typeof value !== "string") {
      return c.json({ error: "key and value must be strings" }, 400);
    }
    if (key.length === 0 || key.length > ENV_MAX_KEY) {
      return c.json({ error: `Key length must be 1..${ENV_MAX_KEY}` }, 400);
    }
    if (value.length > ENV_MAX_VALUE) {
      return c.json({ error: `Value for ${key} exceeds ${ENV_MAX_VALUE} chars` }, 400);
    }
    if (seen.has(key)) {
      return c.json({ error: `Duplicate key: ${key}` }, 400);
    }
    seen.add(key);
    entries.push({ key, value });
  }
  try {
    await appEnv.writeAppEnv(c.req.param("name"), entries);
    return c.json({ entries });
  } catch (err) {
    if (err instanceof RelayConfigError) return c.json({ error: err.message }, 404);
    if (err instanceof Error) return c.json({ error: err.message }, 400);
    throw err;
  }
});
