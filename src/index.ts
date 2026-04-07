import { createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
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

// Hono request listener for non-MCP routes
const honoListener = getRequestListener(app.fetch);

// Node.js HTTP server — routes MCP separately
const server = createServer(async (req, res) => {
  if (req.url?.startsWith("/mcp")) {
    // Auth check for MCP
    const auth = req.headers.authorization;
    if (!auth?.startsWith("Bearer ") || auth.slice(7) !== env.AUTH_TOKEN) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }

    // Create per-session transport
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const mcpServer = createMcpServer();
    await mcpServer.connect(transport);
    await transport.handleRequest(req, res);
    return;
  }

  // All other routes handled by Hono
  honoListener(req, res);
});

server.listen(env.PORT, () => {
  console.log(`agent-relay listening on port ${env.PORT}`);
  console.log(`  API:  http://localhost:${env.PORT}/api`);
  console.log(`  MCP:  http://localhost:${env.PORT}/mcp`);
  console.log(`  Tools: relay_deploy, relay_status, relay_rollback, relay_logs, relay_preflight`);
});
