import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as apps from "../services/apps.js";
import { recordDeploy } from "../services/history.js";
import { RELAY_VERSION } from "../config/version.js";

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: true };

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

function err(message: string): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify({ success: false, error: message }, null, 2) }], isError: true };
}

const COMMIT_REF = /^[a-fA-F0-9]{4,40}$|^HEAD~\d{1,3}$/;
const SERVICE_NAME = /^[a-zA-Z0-9_-]+$/;

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "agent-relay",
    version: RELAY_VERSION,
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
        const result = await apps.deployApp(app, { branch, force });
        if ("blocked" in result && result.blocked) {
          return ok(result);
        }
        await recordDeploy(app, result, "mcp");
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
          const detail = await apps.getAppDetail(app);
          return ok(detail);
        }
        return ok({ apps: await apps.listApps() });
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
        const result = await apps.rollbackApp(app, to_commit);
        if ("blocked" in result && result.blocked) {
          // Same shape/branch as relay_deploy's blocked case: a loud,
          // structured preflight rejection, not the flat err() message a
          // build/up/git failure below still throws into.
          return ok(result);
        }
        await recordDeploy(app, result, "mcp");
        return ok({ ...result, message: `Rolled back to ${result.commitAfter}` });
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
      lines: z.number().max(1000).optional().describe("Number of log lines (default: 50, max: 1000)"),
      service: z.string().regex(SERVICE_NAME, "Invalid service name").optional().describe("Specific service name"),
    },
    async ({ app, lines, service }) => {
      try {
        return ok(await apps.fetchLogs(app, lines, service));
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
        const report = await apps.runPreflight(app);
        return ok({ app, ...report });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );

  return server;
}
