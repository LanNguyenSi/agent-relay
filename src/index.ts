import { createServer } from "node:http";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { env } from "./config/env.js";
import { api } from "./api/routes.js";
import { createMcpServer } from "./mcp/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const app = new Hono();

app.use("*", logger());

// Public health (no auth)
app.get("/health", (c) =>
  c.json({ status: "ok", version: "0.1.0" }),
);

// Authenticated API
app.route("/api", api);

// MCP setup
const mcpServer = createMcpServer();
const mcpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
mcpServer.connect(mcpTransport);

// Node.js HTTP server — handles both Hono routes and MCP
const nodeServer = createServer(async (req, res) => {
  if (req.url?.startsWith("/mcp")) {
    // Auth check for MCP
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.AUTH_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    await mcpTransport.handleRequest(req, res);
    return;
  }

  // All other routes handled by Hono
  return serve({ fetch: app.fetch, createServer: () => nodeServer }); // placeholder, won't be used
});

// Use @hono/node-server to handle non-MCP routes
serve(
  { fetch: app.fetch, port: env.PORT },
  (info) => {
    console.log(`agent-relay listening on port ${info.port}`);
    console.log(`  API:  http://localhost:${info.port}/api`);
    console.log(`  MCP:  http://localhost:${info.port}/mcp`);
    console.log(`  Tools: relay_deploy, relay_status, relay_rollback, relay_logs, relay_preflight`);
  },
);
