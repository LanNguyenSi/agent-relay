import { createServer, type Server } from "node:http";
import { getRequestListener } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { isAuthorized } from "./config/auth.js";
import { RELAY_VERSION } from "./config/version.js";
import { api } from "./api/routes.js";
import { createMcpServer } from "./mcp/server.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** The Hono app for every non-MCP route: public /health plus the authenticated /api. */
export function createApp(): Hono {
  const app = new Hono();

  app.use("*", logger());

  // Public health (no auth)
  app.get("/health", (c) =>
    c.json({ status: "ok", version: RELAY_VERSION }),
  );

  // Authenticated API
  app.route("/api", api);

  return app;
}

/**
 * The Node.js HTTP server: /mcp goes to the MCP transport, everything else to
 * the Hono app through the @hono/node-server request listener. Not listening
 * yet; the caller binds the port.
 */
export function createRelayServer(): Server {
  // Hono request listener for non-MCP routes
  const honoListener = getRequestListener(createApp().fetch);

  return createServer(async (req, res) => {
    if (req.url?.startsWith("/mcp")) {
      // Auth check for MCP
      const auth = req.headers.authorization;
      if (!isAuthorized(auth)) {
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
}
