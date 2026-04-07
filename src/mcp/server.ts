import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { env } from "../config/env.js";
import { loadRelayConfig, RelayConfigError } from "../config/relay.js";
import { deploy } from "../deploy/engine.js";
import { runPreflightChecks } from "../deploy/preflight.js";
import { shell } from "../deploy/exec.js";
import { resolve } from "node:path";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error: message }, null, 2) }], isError: true };
}

function safeAppDir(app: string): string {
  const dir = resolve(env.APPS_DIR, app);
  if (!dir.startsWith(resolve(env.APPS_DIR))) {
    throw new Error("Invalid app path: directory traversal detected");
  }
  return dir;
}

const COMMIT_REF = /^[a-fA-F0-9]{4,40}$|^HEAD~\d{1,3}$/;
const SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_LOG_LINES = 1000;

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-relay",
    version: "0.1.0",
  });

  // ── relay_deploy ──────────────────────────────────────────
  server.tool(
    "relay_deploy",
    "Deploy an app: git pull, compose build, compose up, health check. Auto-rollback on failure.",
    {
      app: z.string().min(1).describe("App directory name under APPS_DIR"),
      branch: z.string().optional().describe("Git branch to pull (default: main)"),
      force: z.boolean().optional().describe("Skip non-critical preflight checks"),
    },
    async ({ app, branch, force }) => {
      try {
        const dir = safeAppDir(app);
        const config = await loadRelayConfig(dir);

        // Run preflight
        const preflight = await runPreflightChecks({ appDir: dir, config, force });
        if (!preflight.passed) {
          return ok({ success: false, blocked: true, preflight });
        }

        const result = await deploy({ appDir: dir, config, branch });
        return ok(result);
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── relay_status ──────────────────────────────────────────
  server.tool(
    "relay_status",
    "Get status of an app or all apps: container state, health, current commit.",
    {
      app: z.string().optional().describe("App name (all apps if omitted)"),
    },
    async ({ app }) => {
      try {
        if (app) {
          const status = await getAppStatus(app);
          return ok(status);
        }

        // List all apps
        const result = await shell("ls -1", env.APPS_DIR);
        if (result.exitCode !== 0) {
          return err("Failed to list apps: " + result.stderr);
        }
        const apps = result.stdout.trim().split("\n").filter(Boolean);
        const statuses = await Promise.all(apps.map(getAppStatus));
        return ok({ apps: statuses });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── relay_rollback ────────────────────────────────────────
  server.tool(
    "relay_rollback",
    "Rollback an app to a previous commit, rebuild, and restart.",
    {
      app: z.string().min(1).describe("App directory name"),
      to_commit: z.string().regex(COMMIT_REF, "Must be a hex SHA or HEAD~N").optional().describe("Target commit SHA (default: HEAD~1)"),
    },
    async ({ app, to_commit }) => {
      try {
        const dir = safeAppDir(app);
        const config = await loadRelayConfig(dir);
        const target = to_commit ?? "HEAD~1";

        const commitBefore = (await shell("git rev-parse HEAD", dir)).stdout.trim();

        const checkout = await shell(`git reset --hard '${target}'`, dir);
        if (checkout.exitCode !== 0) {
          return err("Rollback failed: " + checkout.stderr);
        }

        const build = await shell(`docker compose -f '${config.compose_file}' build`, dir);
        if (build.exitCode !== 0) {
          return err("Rebuild failed: " + build.stderr);
        }

        const up = await shell(`docker compose -f '${config.compose_file}' up -d`, dir);
        if (up.exitCode !== 0) {
          return err("Restart failed: " + up.stderr);
        }

        const commitAfter = (await shell("git rev-parse HEAD", dir)).stdout.trim();
        return ok({ success: true, commitBefore, commitAfter, message: `Rolled back to ${commitAfter}` });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── relay_logs ────────────────────────────────────────────
  server.tool(
    "relay_logs",
    "Get recent docker compose logs for an app.",
    {
      app: z.string().min(1).describe("App directory name"),
      lines: z.number().max(MAX_LOG_LINES).optional().describe("Number of log lines (default: 50, max: 1000)"),
      service: z.string().regex(SERVICE_NAME, "Invalid service name").optional().describe("Specific service name"),
    },
    async ({ app, lines, service }) => {
      try {
        const dir = safeAppDir(app);
        const config = await loadRelayConfig(dir);
        const n = Math.min(lines ?? 50, MAX_LOG_LINES);
        const svc = service ?? "";

        const result = await shell(
          `docker compose -f '${config.compose_file}' logs --tail=${n} --no-color ${svc}`.trim(),
          dir,
        );

        if (result.exitCode !== 0) {
          return err("Failed to get logs: " + result.stderr);
        }

        return ok({ app, lines: n, logs: result.stdout });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  // ── relay_preflight ───────────────────────────────────────
  server.tool(
    "relay_preflight",
    "Run pre-flight checks on an app without deploying.",
    {
      app: z.string().min(1).describe("App directory name"),
    },
    async ({ app }) => {
      try {
        const dir = safeAppDir(app);
        const config = await loadRelayConfig(dir);
        const report = await runPreflightChecks({ appDir: dir, config });
        return ok({ app, ...report });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}

async function getAppStatus(app: string): Promise<Record<string, unknown>> {
  const dir = safeAppDir(app);

  let config;
  try {
    config = await loadRelayConfig(dir);
  } catch (e) {
    return { app, configured: false, error: e instanceof RelayConfigError ? e.message : String(e) };
  }

  const [commitResult, psResult] = await Promise.all([
    shell("git rev-parse --short HEAD", dir),
    shell(`docker compose -f '${config.compose_file}' ps --format json`, dir),
  ]);

  return {
    app,
    configured: true,
    name: config.name,
    health: config.health,
    commit: commitResult.stdout.trim() || "unknown",
    containers: psResult.exitCode === 0 ? psResult.stdout.trim() : "error: " + psResult.stderr,
  };
}
