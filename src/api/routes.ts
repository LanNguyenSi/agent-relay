import { Hono } from "hono";
import { env } from "../config/env.js";
import { loadRelayConfig, RelayConfigError } from "../config/relay.js";
import { deploy } from "../deploy/engine.js";
import { runPreflightChecks } from "../deploy/preflight.js";
import { shell } from "../deploy/exec.js";
import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";

export const api = new Hono();

// ── Auth middleware ─────────────────────────────────────────────────────────
api.use("*", async (c, next) => {
  const auth = c.req.header("Authorization");
  if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.AUTH_TOKEN) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
});

// ── Simple deploy history (in-memory, latest 100) ───────────────────────────
interface DeployRecord {
  id: string;
  app: string;
  status: string;
  commitBefore: string;
  commitAfter: string;
  durationMs: number;
  triggeredBy: string;
  createdAt: string;
}

const deployHistory: DeployRecord[] = [];
let deployCounter = 0;

function recordDeploy(app: string, result: any, triggeredBy: string): DeployRecord {
  const record: DeployRecord = {
    id: `d-${++deployCounter}`,
    app,
    status: result.success ? "success" : "failed",
    commitBefore: result.commitBefore ?? "",
    commitAfter: result.commitAfter ?? "",
    durationMs: result.durationMs ?? 0,
    triggeredBy,
    createdAt: new Date().toISOString(),
  };
  deployHistory.unshift(record);
  if (deployHistory.length > 100) deployHistory.pop();
  return record;
}

// ── GET /api/health ─────────────────────────────────────────────────────────
api.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: "0.1.0",
    uptime: process.uptime(),
  });
});

// ── GET /api/apps ───────────────────────────────────────────────────────────
api.get("/apps", async (c) => {
  try {
    const entries = await readdir(env.APPS_DIR, { withFileTypes: true });
    const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name);

    const apps = await Promise.all(
      dirs.map(async (name) => {
        const dir = join(env.APPS_DIR, name);
        try {
          const config = await loadRelayConfig(dir);
          const commit = await shell("git rev-parse --short HEAD", dir);
          return {
            name,
            configured: true,
            health: config.health,
            commit: commit.stdout.trim() || "unknown",
          };
        } catch {
          return { name, configured: false };
        }
      }),
    );

    return c.json({ apps });
  } catch {
    return c.json({ apps: [] });
  }
});

// ── GET /api/apps/:name ────────────────────────────────────────────────────
api.get("/apps/:name", async (c) => {
  const name = c.req.param("name");
  const dir = safeAppDir(name);

  try {
    const config = await loadRelayConfig(dir);
    const commit = await shell("git rev-parse --short HEAD", dir);
    const ps = await shell(`docker compose -f '${config.compose_file}' ps --format json`, dir);

    return c.json({
      app: {
        name,
        config,
        commit: commit.stdout.trim(),
        containers: ps.exitCode === 0 ? ps.stdout.trim() : null,
        recentDeploys: deployHistory.filter((d) => d.app === name).slice(0, 10),
      },
    });
  } catch (err) {
    if (err instanceof RelayConfigError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// ── POST /api/apps/:name/deploy ────────────────────────────────────────────
api.post("/apps/:name/deploy", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const dir = safeAppDir(name);

  try {
    const config = await loadRelayConfig(dir);

    // Preflight
    const preflight = await runPreflightChecks({ appDir: dir, config, force: body.force });
    if (!preflight.passed) {
      return c.json({ success: false, blocked: true, preflight });
    }

    const result = await deploy({ appDir: dir, config, branch: body.branch });
    const record = recordDeploy(name, result, "api");

    return c.json({ deploy: record, result });
  } catch (err) {
    if (err instanceof RelayConfigError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// ── POST /api/apps/:name/rollback ──────────────────────────────────────────
api.post("/apps/:name/rollback", async (c) => {
  const name = c.req.param("name");
  const body = await c.req.json().catch(() => ({}));
  const dir = safeAppDir(name);

  try {
    const config = await loadRelayConfig(dir);
    const target = body.to_commit ?? "HEAD~1";

    if (!/^[a-fA-F0-9]{4,40}$|^HEAD~\d{1,3}$/.test(target)) {
      return c.json({ error: "Invalid commit reference" }, 400);
    }

    const commitBefore = (await shell("git rev-parse HEAD", dir)).stdout.trim();

    const checkout = await shell(`git reset --hard '${target}'`, dir);
    if (checkout.exitCode !== 0) {
      return c.json({ success: false, error: "Rollback failed: " + checkout.stderr });
    }

    const build = await shell(`docker compose -f '${config.compose_file}' build`, dir);
    if (build.exitCode !== 0) {
      return c.json({ success: false, error: "Rebuild failed: " + build.stderr });
    }

    const up = await shell(`docker compose -f '${config.compose_file}' up -d`, dir);
    if (up.exitCode !== 0) {
      return c.json({ success: false, error: "Restart failed: " + up.stderr });
    }

    const commitAfter = (await shell("git rev-parse HEAD", dir)).stdout.trim();
    const record = recordDeploy(name, { success: true, commitBefore, commitAfter, durationMs: 0 }, "api");

    return c.json({ success: true, deploy: record, commitBefore, commitAfter });
  } catch (err) {
    if (err instanceof RelayConfigError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// ── GET /api/apps/:name/logs ───────────────────────────────────────────────
api.get("/apps/:name/logs", async (c) => {
  const name = c.req.param("name");
  const lines = Math.min(Number(c.req.query("lines") ?? 50), 1000);
  const service = c.req.query("service") ?? "";
  const dir = safeAppDir(name);

  if (service && !/^[a-zA-Z0-9_-]+$/.test(service)) {
    return c.json({ error: "Invalid service name" }, 400);
  }

  try {
    const config = await loadRelayConfig(dir);
    const result = await shell(
      `docker compose -f '${config.compose_file}' logs --tail=${lines} --no-color ${service}`.trim(),
      dir,
    );

    return c.json({ app: name, lines, logs: result.stdout });
  } catch (err) {
    if (err instanceof RelayConfigError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// ── GET /api/apps/:name/preflight ──────────────────────────────────────────
api.get("/apps/:name/preflight", async (c) => {
  const name = c.req.param("name");
  const dir = safeAppDir(name);

  try {
    const config = await loadRelayConfig(dir);
    const report = await runPreflightChecks({ appDir: dir, config });
    return c.json({ app: name, ...report });
  } catch (err) {
    if (err instanceof RelayConfigError) {
      return c.json({ error: err.message }, 404);
    }
    throw err;
  }
});

// ── GET /api/deploys ───────────────────────────────────────────────────────
api.get("/deploys", (c) => {
  const app = c.req.query("app");
  const filtered = app ? deployHistory.filter((d) => d.app === app) : deployHistory;
  return c.json({ deploys: filtered });
});

// ── Helpers ────────────────────────────────────────────────────────────────

function safeAppDir(name: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    throw new RelayConfigError("Invalid app name");
  }
  const dir = resolve(env.APPS_DIR, name);
  if (!dir.startsWith(resolve(env.APPS_DIR))) {
    throw new RelayConfigError("Invalid app path");
  }
  return dir;
}
